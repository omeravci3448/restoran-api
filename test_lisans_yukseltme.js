// Deneme -> paket -> yukseltme (Patron karari 2026-11-11). Kapsam: tur siniflamasi (ilk / yenileme / yukseltme),
// kalan sure kredisi (onayli odemeden ve odeme yoksa katalogdan, kiraci indirimiyle), odenecek = yeni toplam - kredi
// (en az 0), teklifin talep aninda KILITLENMESI (katalog sonradan degisse de), onaya kadar lisansin HIC degismemesi,
// onayda bitis (ilk/yukseltme: onay gunu + 365; yenileme: mevcut bitisin uzerine), donem icinde azaltma 409,
// gizli modullerin (Masadan Siparis, Pazaryeri) korunmasi, root listesindeki "talepten sonra degisti" uyarisi,
// cift onay korumasi, red; K1: onayda korunan moduller (gecmis kiraci yenilemesi, deploy oncesi bekleyen kayit,
// ALL, deneme korumasiz + aktif pazaryeri kanali istisnasi). Sunucuyu KENDI baslatir.  Calistir: node test_lisans_yukseltme.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 46123, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'lisans-yukseltme-test-jwt';
const ON = 'YKS Test';
const EPOSTA_ON = 'yks-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const yakin = (a, b, tol = 5 * 60000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < tol;
const ayniKume = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

// Bitis: "simdi + gun - 1 saat" -> kalan gun (yukari yuvarlama) tam olarak 'gun'
const bitisGun = (gun) => new Date(Date.now() + gun * GUN - 3600000).toISOString();

async function kiraciKur({ ad, tier, moduller, bitis, indirim = 0, limit = null }) {
    const id = uuid();
    const slug = 'yks-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, license_table_limit, discount_rate, is_active)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, ?, ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller), bitis, limit, indirim]);
    const uid = uuid();
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid, id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, token: g.d && g.d.token, girisDurumu: g.status };
}
// Onayli yillik odeme (donemi suren): tutar, donem bitisi, onaydan bu yana gecen gun
async function odemeKur(tenantId, { tutar, yeniToplam = null, donemBitis, gecen = 165, onayGun = 365, tier = 'TIER_6_10' }) {
    const id = 'yks-odeme-' + crypto.randomBytes(4).toString('hex');
    await query(
        `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, yeni_toplam, durum, donem_bitis, islenen_at, onay_gun)
         VALUES (?, ?, ?, '[]', ?, ?, 'onaylandi', ?, datetime('now', ?), ?)`,
        [id, tenantId, tier, tutar, yeniToplam, donemBitis, `-${gecen} days`, onayGun]);
    return id;
}
// Odeme gecmisi (karar 1): donemi bitmis eski onayli ucretli odeme. Kredi hesabina girmez; isletmeyi "ilk alim"
// olmaktan cikarir.
async function gecmisKur(tenantId) {
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 1000, 'onaylandi', datetime('now', '-30 days'), datetime('now', '-395 days'), 365)`,
        ['yks-gecmis-' + crypto.randomBytes(4).toString('hex'), tenantId]);
}
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];
const kayit = async (id) => (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [id])).rows[0];
const modulleri = async (id) => JSON.parse((await kiraci(id)).license_modules || '[]');

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
        for (const tb of ['lisans_odemeleri', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
}
const fiyatYaz = (id, fiyat, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, gorunur, id]);

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    // Sabit katalog: kademe fiyati = Adisyon ve Kasa fiyati
    await fiyatYaz('TIER-TIER_1_5', 3000); await fiyatYaz('TIER-TIER_6_10', 4000); await fiyatYaz('TIER-TIER_11_20', 6000);
    await fiyatYaz('TIER-TIER_20_PLUS', 9000); await fiyatYaz('MODUL-BASE', 99999); await fiyatYaz('MODUL-MENU_DIGITAL', 1000);
    await fiyatYaz('MODUL-GARSON', 500); await fiyatYaz('MODUL-STOK', 800);
    await fiyatYaz('MODUL-QR_SIPARIS', 0, 0); await fiyatYaz('MODUL-MARKETPLACE', 700, 0);

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const onayla = (id, gun = 365) => js(`/api/root/lisans-odemeleri/${id}/onayla`, { token: rj, body: { gun } });
    const rootKaydi = async (id) => (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === id);

    console.log('=== 0) Sema ===');
    const kolonlar = (await query('PRAGMA table_info(lisans_odemeleri)')).rows.map((x) => x.name);
    ok('lisans_odemeleri yeni sutunlar', ['tur', 'yeni_toplam', 'kredi_tutari', 'kalan_gun', 'kredi_kaynak', 'onceki_tier', 'onceki_moduller', 'onceki_bitis']
        .every((k) => kolonlar.includes(k)), kolonlar);

    console.log('\n=== 1) Yukseltme: onayli odemeden kredi (ORNEK HESAP) ===');
    const b1 = bitisGun(200);
    const u1 = await kiraciKur({ ad: 'Yukselt Bir', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'], bitis: b1 });
    await odemeKur(u1.id, { tutar: 5000, donemBitis: b1 });
    const dn = (await js('/api/license/yenileme-kanali', { token: u1.token })).d;
    ok('donem bilgisi: donemIci, kalan 200 gun, masa siniri 10, korunan Masadan Siparis', dn.kanal === 'yerel' && dn.donem && dn.donem.durum === 'donemIci'
        && dn.donem.kalanGun === 200 && dn.donem.mevcut.masaLimiti === 10 && JSON.stringify(dn.donem.mevcut.korunan) === '["QR_SIPARIS"]', dn);
    const q1 = (await js('/api/license/quote', { token: u1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    // Yeni toplam 4000 + 1000 + 500 = 5500; kredi 5000 x 200 / 365 = 2739,73; odenecek 2760,27
    ok('teklif: tur yukseltme, yeni toplam 5500', q1.tur === 'yukseltme' && q1.total === 5500, q1);
    ok('kredi = 5000 x 200 / 365 = 2739,73 (onayli odemeden)', q1.krediTutari === 2739.73 && q1.kalanGun === 200 && q1.krediKaynak === 'odeme', q1);
    ok('odenecek = 5500 - 2739,73 = 2760,27', q1.odenecek === 2760.27, q1.odenecek);
    ok('Masadan Siparis (gizli) korunur, ucrete eklenmez', q1.modules.includes('QR_SIPARIS') && JSON.stringify(q1.korunanModuller) === '["QR_SIPARIS"]'
        && q1.breakdown.some((b) => b.name === 'QR_SIPARIS' && b.price === 0 && b.korunan), q1.breakdown);
    ok('musteri metni', q1.aciklama === 'Kalan 200 gününüz 2.739,73 TL olarak düşüldü. Yeni 1 yıllık süreniz ödemeniz onaylandığı gün başlar; o güne kadar mevcut paketiniz aynen çalışır.', q1.aciklama);
    const once1 = await kiraci(u1.id);
    const al1 = await js('/api/license/purchase', { token: u1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('talep 201: tur yukseltme, toplam 5500, odenecek 2760,27', al1.status === 201 && al1.d.tur === 'yukseltme' && al1.d.total === 5500 && al1.d.odenecek === 2760.27, al1);
    const k1 = await kayit(al1.d.id);
    ok('teklif kayda kilitlendi (tutar=odenecek, yeni_toplam, kredi, kalan gun, kaynak)', k1.tur === 'yukseltme' && k1.tutar === 2760.27 && k1.yeni_toplam === 5500
        && k1.kredi_tutari === 2739.73 && k1.kalan_gun === 200 && k1.kredi_kaynak === 'odeme', k1);
    ok('onceki lisansin kopyasi', k1.onceki_tier === 'TIER_6_10' && k1.onceki_moduller === once1.license_modules && k1.onceki_bitis === once1.license_end_date, k1);
    const sonra1 = await kiraci(u1.id);
    ok('ONAYA KADAR lisans degismez (paket, moduller, bitis, masa siniri)', sonra1.license_tier === once1.license_tier && sonra1.license_modules === once1.license_modules
        && sonra1.license_end_date === once1.license_end_date && String(sonra1.license_table_limit) === String(once1.license_table_limit), [once1, sonra1]);
    ok('onaydan once Garson kapali (403)', (await js('/api/waiter/calls', { token: u1.token })).status === 403);
    const odm1 = await js('/api/license/purchases/' + al1.d.id, { token: u1.token });
    ok('musteri kaydinda tur/kredi/kalan gun/odenecek', odm1.d.tur === 'yukseltme' && odm1.d.amount === 2760.27 && odm1.d.yeni_toplam === 5500 && odm1.d.kalan_gun === 200, odm1.d);
    const gec1 = (await js('/api/license/purchases', { token: u1.token })).d.find((x) => x.id === al1.d.id);
    ok('satin alma gecmisinde tur', gec1.tur === 'yukseltme' && gec1.kredi_tutari === 2739.73, gec1);
    await js('/api/license/purchases/' + al1.d.id + '/mark-paid', { token: u1.token, body: { paymentRef: 'dekont 1' } });
    const rk1 = await rootKaydi(al1.d.id);
    ok('root listesi: tur, toplam, kredi, onceki paket, uyari yok, kalkacak modul yok', rk1 && rk1.tur === 'yukseltme' && rk1.yeni_toplam === 5500 && rk1.kredi_tutari === 2739.73
        && rk1.onceki_tier_ad && Array.isArray(rk1.onceki_moduller) && rk1.lisans_degisiklikleri.length === 0 && rk1.kalkacak_moduller.length === 0, rk1);
    ok('root listesi: onaylanirsa yeni bitis bugun + 365', yakin(rk1.yeni_bitis_onizleme, Date.now() + 365 * GUN), rk1.yeni_bitis_onizleme);
    const on1 = await onayla(al1.d.id);
    const t1 = await kiraci(u1.id);
    ok('onay 200 + yukseltme mesaji', on1.status === 200 && on1.d.tur === 'yukseltme' && /yükseltme onaylandı/.test(on1.d.message), on1.d);
    ok('onayda moduller ve paket degisti (Garson eklendi, Masadan Siparis korundu)', ayniKume(JSON.parse(t1.license_modules), ['BASE', 'MENU_DIGITAL', 'GARSON', 'QR_SIPARIS'])
        && t1.license_tier === 'TIER_6_10' && Number(t1.license_table_limit) === 10, t1);
    ok('yeni 1 yil ONAY GUNUNDEN (bugun + 365, eski bitisin uzerine degil)', yakin(t1.license_end_date, Date.now() + 365 * GUN), t1.license_end_date);
    const k1b = await kayit(al1.d.id);
    ok('kayit onaylandi: onay_gun 365, donem_bitis = yeni bitis', k1b.durum === 'onaylandi' && k1b.onay_gun === 365 && k1b.donem_bitis === t1.license_end_date, k1b);
    ok('onaydan sonra Garson acik (200)', (await js('/api/waiter/calls', { token: u1.token })).status === 200);
    const q1b = (await js('/api/license/quote', { token: u1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK'] } })).d;
    ok('zincir yukseltme: kredi yukseltme kaydinin YILLIK degerinden (5500 x 365/365), odenecek 800', q1b.tur === 'yukseltme' && q1b.kalanGun === 365
        && q1b.krediTutari === 5500 && q1b.total === 6300 && q1b.odenecek === 800, q1b);

    console.log('\n=== 2) Yukseltme: odeme kaydi yok -> katalog fiyatindan kredi, kiraci indirimi ===');
    const u2 = await kiraciKur({ ad: 'Yukselt Iki', tier: 'TIER_1_5', moduller: ['BASE'], bitis: bitisGun(100), indirim: 10 });
    await gecmisKur(u2.id);   // odeme gecmisi var ama donemi suren odeme yok (orn. elle uzatilmis)
    const q2 = (await js('/api/license/quote', { token: u2.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } })).d;
    // Yeni: 4000 - %10 = 3600. Kredi: mevcut paket (1-5 Masa, 3000 - %10 = 2700) x 100 / 365 = 739,73. Odenecek 2860,27
    ok('buyuk masa paketine gecis = yukseltme; toplam 3600 (indirimli)', q2.tur === 'yukseltme' && q2.subtotal === 4000 && q2.discountAmount === 400 && q2.total === 3600, q2);
    ok('kredi = 2700 x 100 / 365 = 739,73 (katalog), odenecek 2860,27', q2.krediTutari === 739.73 && q2.krediKaynak === 'katalog' && q2.odenecek === 2860.27, q2);
    const q2g = await js('/api/license/quote', { token: u2.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'QR_SIPARIS'] } });
    ok('sahip olunmayan gizli modul satin alinamaz (400)', q2g.status === 400, q2g);

    console.log('\n=== 3) Donem ici: azaltma 409, ayni secim = erken yenileme ===');
    const b3 = bitisGun(200);
    const u3 = await kiraciKur({ ad: 'Donem Ici', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'], bitis: b3 });
    await odemeKur(u3.id, { tutar: 5500, donemBitis: b3 });
    const c3 = await js('/api/license/purchase', { token: u3.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('modul cikarma 409 DONEM_ICI_AZALTMA (Garson adiyla)', c3.status === 409 && c3.d.code === 'DONEM_ICI_AZALTMA' && /Garson/.test(c3.d.message)
        && JSON.stringify(c3.d.cikanModuller) === '["GARSON"]', c3);
    ok('teklif de 409', (await js('/api/license/quote', { token: u3.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).status === 409);
    const c3b = await js('/api/license/purchase', { token: u3.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('kucuk masa paketi 409 (mesaj)', c3b.status === 409 && /daha küçük masa paketine/.test(c3b.d.message), c3b);
    ok('reddedilen taleplerde kayit acilmadi', (await query("SELECT COUNT(*) c FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede'", [u3.id])).rows[0].c === 0);
    const al3 = await js('/api/license/purchase', { token: u3.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('ayni secim: erken yenileme, kredi yok, odenecek = 5500', al3.status === 201 && al3.d.tur === 'yenileme' && al3.d.odenecek === 5500 && al3.d.krediTutari === 0
        && /mevcut bitiş tarihinizin/.test(al3.d.aciklama), al3.d);
    const on3 = await onayla(al3.d.id);
    ok('erken yenileme onayi: 1 yil MEVCUT BITISIN UZERINE', on3.status === 200 && yakin((await kiraci(u3.id)).license_end_date, new Date(b3).getTime() + 365 * GUN, 2000), on3.d);

    console.log('\n=== 4) Yenileme donemi (<= 30 gun): cikarma serbest, bitisin uzerine ===');
    const b4 = bitisGun(20);
    const u4 = await kiraciKur({ ad: 'Yenileme', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'], bitis: b4 });
    await gecmisKur(u4.id);
    ok('donem bilgisi: yenileme', (await js('/api/license/yenileme-kanali', { token: u4.token })).d.donem.durum === 'yenileme');
    const al4 = await js('/api/license/purchase', { token: u4.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('yenilemede Garson cikarilir + kucuk paket: 201, toplam 4000, kredi yok', al4.status === 201 && al4.d.tur === 'yenileme' && al4.d.total === 4000
        && al4.d.odenecek === 4000 && al4.d.krediTutari === 0, al4.d);
    ok('Masadan Siparis yenilemede korunur', ayniKume(al4.d.modules, ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS']), al4.d.modules);
    await onayla(al4.d.id);
    const t4 = await kiraci(u4.id);
    ok('onay: bitisin uzerine 1 yil, 1-5 Masa (sinir 5), Garson yok, QR siparisi acik', yakin(t4.license_end_date, new Date(b4).getTime() + 365 * GUN, 2000)
        && t4.license_tier === 'TIER_1_5' && Number(t4.license_table_limit) === 5 && ayniKume(JSON.parse(t4.license_modules), ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS']), t4);
    ok('... QR siparisi fiilen acik (profil)', (await js('/api/tenant/me', { token: u4.token })).d.qr_ozellikleri.siparis === true);

    console.log('\n=== 5) Bitmis lisans (salt okunur donem): yenileme, onay gunu + 365 ===');
    const u5 = await kiraciKur({ ad: 'Bitmis', tier: 'TIER_6_10', moduller: ['BASE'], bitis: new Date(Date.now() - 1 * GUN).toISOString() });
    await gecmisKur(u5.id);
    const al5 = await js('/api/license/purchase', { token: u5.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } });
    ok('bitmis: tur yenileme, metin "onaylandığı gün"', al5.status === 201 && al5.d.tur === 'yenileme' && /onaylandığı gün lisansınız 1 yıl uzar/.test(al5.d.aciklama), al5.d);
    await onayla(al5.d.id);
    ok('onay: bugun + 365', yakin((await kiraci(u5.id)).license_end_date, Date.now() + 365 * GUN));

    console.log('\n=== 6) Deneme -> ilk alim: secim serbest, onay gununden 1 yil ===');
    const u6 = await kiraciKur({ ad: 'Deneme', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK', 'MARKETPLACE'], bitis: bitisGun(5) });
    ok('donem bilgisi: deneme', (await js('/api/license/yenileme-kanali', { token: u6.token })).d.donem.durum === 'deneme');
    const q6 = (await js('/api/license/quote', { token: u6.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('teklif: tur ilk, toplam 5000, kredi yok', q6.tur === 'ilk' && q6.total === 5000 && q6.odenecek === 5000 && q6.krediTutari === 0, q6);
    ok('K1: denemede koruma yok (Masadan Siparis / Pazaryeri gelmez), secilmeyen Garson/Stok gelmez', q6.korunanModuller.length === 0
        && ayniKume(q6.modules, ['BASE', 'MENU_DIGITAL']), q6.modules);
    const q6b = (await js('/api/license/quote', { token: u6.token, body: { tier: 'TIER_1_5', modules: ['MENU_DIGITAL'] } })).d;
    ok('yalniz QR Menu: tek modul, toplam 1000', JSON.stringify(q6b.modules) === '["MENU_DIGITAL"]' && q6b.total === 1000, q6b);
    const al6 = await js('/api/license/purchase', { token: u6.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    const on6 = await onayla(al6.d.id);
    const t6 = await kiraci(u6.id);
    ok('ilk alim onayi: bugun + 365 (kalan 5 deneme gunu eklenmez)', on6.status === 200 && on6.d.tur === 'ilk' && yakin(t6.license_end_date, Date.now() + 365 * GUN), t6.license_end_date);
    ok('... paket 6-10 Masa (sinir 10), deneme bitti', t6.license_tier === 'TIER_6_10' && Number(t6.license_table_limit) === 10);
    ok('K1: deneme -> satin alma onayi: yalniz odenen moduller (Masadan Siparis, Pazaryeri korunmaz)', ayniKume(JSON.parse(t6.license_modules), ['BASE', 'MENU_DIGITAL']), t6.license_modules);

    console.log('\n=== 7) Kilitli teklif + talepten sonra elle degisiklik uyarisi ===');
    const b7 = bitisGun(200);
    const u7 = await kiraciKur({ ad: 'Kilit', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitis: b7 });
    await odemeKur(u7.id, { tutar: 5000, donemBitis: b7 });
    const al7 = await js('/api/license/purchase', { token: u7.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('talep: odenecek 2760,27', al7.status === 201 && al7.d.odenecek === 2760.27, al7.d);
    await fiyatYaz('MODUL-GARSON', 9999);
    const ed7 = await js('/api/root/tenants/' + u7.id, { token: rj, method: 'PATCH', body: { modules: ['BASE', 'MENU_DIGITAL', 'STOK'] } });
    const rk7 = await rootKaydi(al7.d.id);
    ok('root elle Stok ekledi -> listede uyari + onaylanirsa kalkacak: Stok', ed7.status === 200 && rk7.lisans_degisiklikleri.length === 1
        && /Stok/.test(rk7.lisans_degisiklikleri[0]) && JSON.stringify(rk7.kalkacak_moduller) === '["STOK"]', rk7);
    const on7 = await onayla(al7.d.id);
    const k7 = await kayit(al7.d.id);
    ok('katalog fiyati sonradan degisti: onayda KILITLI tutar (2760,27 / 5500) gecerli', on7.status === 200 && k7.tutar === 2760.27 && k7.yeni_toplam === 5500, k7);
    ok('onayda kilitli secim yazilir (Garson var, sonradan eklenen Stok yok)', ayniKume(await modulleri(u7.id), ['BASE', 'MENU_DIGITAL', 'GARSON']), await modulleri(u7.id));
    await fiyatYaz('MODUL-GARSON', 500);

    console.log('\n=== 8) Kredi yeni toplami asarsa odenecek 0 ===');
    const b8 = bitisGun(300);
    const u8 = await kiraciKur({ ad: 'Sifir', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitis: b8 });
    await odemeKur(u8.id, { tutar: 20000, donemBitis: b8, gecen: 65 });
    const q8 = (await js('/api/license/quote', { token: u8.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    ok('kredi 20000 x 300 / 365 = 16438,36 > 5500 -> odenecek 0 + aciklama', q8.krediTutari === 16438.36 && q8.odenecek === 0 && /ödenecek tutar 0 TL/.test(q8.aciklama), q8);

    console.log('\n=== 9) Cift onay, red, tum moduller (ALL) ===');
    const u9 = await kiraciKur({ ad: 'Cift', tier: 'TIER_6_10', moduller: ['BASE'], bitis: bitisGun(10) });
    await gecmisKur(u9.id);
    const b9 = (await kiraci(u9.id)).license_end_date;
    const al9 = await js('/api/license/purchase', { token: u9.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } });
    const [o9a, o9b] = await Promise.all([onayla(al9.d.id), onayla(al9.d.id)]);
    ok('ayni kayda es zamanli iki onay: biri 200 biri 409', [o9a.status, o9b.status].sort().join(',') === '200,409', [o9a.status, o9b.status]);
    ok('lisans YALNIZ BIR KEZ uzadi', yakin((await kiraci(u9.id)).license_end_date, new Date(b9).getTime() + 365 * GUN, 2000), (await kiraci(u9.id)).license_end_date);
    const b10 = bitisGun(200);
    const u10 = await kiraciKur({ ad: 'Red', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitis: b10 });
    await gecmisKur(u10.id);
    const once10 = await kiraci(u10.id);
    const al10 = await js('/api/license/purchase', { token: u10.token, body: { tier: 'TIER_11_20', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('yalniz masa paketi buyutme = yukseltme', al10.status === 201 && al10.d.tur === 'yukseltme', al10.d);
    const rd10 = await js(`/api/root/lisans-odemeleri/${al10.d.id}/reddet`, { token: rj, body: { not: 'Havale görülmedi' } });
    const t10 = await kiraci(u10.id);
    ok('red: lisans aynen kalir', rd10.status === 200 && t10.license_tier === once10.license_tier && t10.license_modules === once10.license_modules
        && t10.license_end_date === once10.license_end_date, t10);
    const u11 = await kiraciKur({ ad: 'Tum', tier: 'TIER_20_PLUS', moduller: ['ALL'], bitis: bitisGun(200) });
    await gecmisKur(u11.id);
    const q11 = (await js('/api/license/quote', { token: u11.token, body: { tier: 'TIER_20_PLUS', modules: ['BASE'] } })).d;
    ok('K1: ALL korunur (satin alinamaz): tek modul secimi de erken yenileme, korunanlarda ALL', q11.tur === 'yenileme' && q11.korunanModuller.includes('ALL'), q11);
    const al11 = await js('/api/license/purchase', { token: u11.token, body: { tier: 'TIER_20_PLUS', modules: ['BASE'] } });
    await onayla(al11.d.id);
    ok('K1: ALL kiraci onaydan sonra ALL korunur', JSON.parse((await kiraci(u11.id)).license_modules).includes('ALL'), (await kiraci(u11.id)).license_modules);

    console.log('\n=== 10) K1: onayda korunan moduller ===');
    // Gecmis kiraci (gecis sonrasi bicim: BASE + MENU_DIGITAL + QR_SIPARIS + GARSON) yenileme -> onay
    const g1 = await kiraciKur({ ad: 'Gecmis', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'], bitis: bitisGun(20) });
    await gecmisKur(g1.id);
    const gal = await js('/api/license/purchase', { token: g1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('kayitta yalniz ODENEN moduller (Masadan Siparis yok), yanitta korunan onizlemesi', gal.status === 201
        && JSON.stringify(JSON.parse((await kayit(gal.d.id)).moduller).sort()) === JSON.stringify(['BASE', 'GARSON', 'MENU_DIGITAL'])
        && JSON.stringify(gal.d.korunanModuller) === '["QR_SIPARIS"]', gal.d);
    const rg = await rootKaydi(gal.d.id);
    ok('root listesi: korunacak Masadan Siparis, kalkacak modul yok', JSON.stringify(rg.korunacak_moduller) === '["QR_SIPARIS"]' && rg.kalkacak_moduller.length === 0, rg);
    await onayla(gal.d.id);
    ok('K1: gecmis kiraci -> yenileme -> onay: QR_SIPARIS kalir', JSON.parse((await kiraci(g1.id)).license_modules).includes('QR_SIPARIS'), (await kiraci(g1.id)).license_modules);
    // Deploy oncesi acilmis bekleyen kayit (tur / kopya yok, moduller eski sepetten)
    const g2 = await kiraciKur({ ad: 'Eski Bekleyen', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'], bitis: bitisGun(20) });
    await gecmisKur(g2.id);
    const b2 = (await kiraci(g2.id)).license_end_date;
    const eskiId = 'yks-eski-' + crypto.randomBytes(4).toString('hex');
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, aciklama) VALUES (?, ?, 'TIER_6_10', '["BASE","MENU_DIGITAL"]', 5000, 'beklemede', 'eski sepet')`, [eskiId, g2.id]);
    const re = await rootKaydi(eskiId);
    ok('eski kayit root listesinde: tur yok, uyari yok, korunacak Masadan Siparis', re && re.tur == null && re.lisans_degisiklikleri.length === 0
        && JSON.stringify(re.korunacak_moduller) === '["QR_SIPARIS"]', re);
    const one = await onayla(eskiId);
    const tg2 = await kiraci(g2.id);
    ok('K1: deploy oncesi bekleyen kaydin onayi: QR_SIPARIS kalir, bitisin uzerine 1 yil (eski davranis)', one.status === 200
        && JSON.parse(tg2.license_modules).includes('QR_SIPARIS') && yakin(tg2.license_end_date, new Date(b2).getTime() + 365 * GUN, 2000), tg2);
    // Deneme + aktif pazaryeri kanali: yalniz MARKETPLACE korunur
    const d1 = await kiraciKur({ ad: 'Deneme Kanal', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK', 'MARKETPLACE'], bitis: bitisGun(5) });
    const kanal = 'yks-kanal-' + crypto.randomBytes(4).toString('hex');
    await query("INSERT INTO marketplace_channels (id, tenant_id, name, is_active, adapter_code) VALUES (?, ?, 'SofraMix', 1, 'soframix')", [kanal, d1.id]);
    await query("INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, is_active) VALUES (?, ?, ?, ?, 1)", [kanal + '-l', d1.id, kanal, 'm-' + kanal]);
    await query("INSERT INTO marketplace_credentials (id, tenant_id, channel_id, cipher_blob, iv, auth_tag, status) VALUES (?, ?, ?, 'x', 'x', 'x', 'active')", [kanal + '-k', d1.id, kanal]);
    const qd1 = (await js('/api/license/quote', { token: d1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('K1: deneme + aktif pazaryeri kanali: yalniz Pazaryeri korunur (Masadan Siparis korunmaz)', JSON.stringify(qd1.korunanModuller) === '["MARKETPLACE"]', qd1.korunanModuller);
    const ald1 = await js('/api/license/purchase', { token: d1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    const rd1 = await rootKaydi(ald1.d.id);
    ok('root listesi: denemede kalkacaklar (Masadan Siparis, Garson, Stok), korunacak Pazaryeri', ayniKume(rd1.kalkacak_moduller, ['QR_SIPARIS', 'GARSON', 'STOK'])
        && JSON.stringify(rd1.korunacak_moduller) === '["MARKETPLACE"]', rd1);
    await onayla(ald1.d.id);
    ok('K1: deneme -> satin alma (aktif kanal): BASE + QR Menu + Pazaryeri', ayniKume(JSON.parse((await kiraci(d1.id)).license_modules), ['BASE', 'MENU_DIGITAL', 'MARKETPLACE']),
        (await kiraci(d1.id)).license_modules);
    // Kanal pasifse koruma yok
    const d2 = await kiraciKur({ ad: 'Deneme Pasif Kanal', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'MARKETPLACE'], bitis: bitisGun(5) });
    const kanal2 = 'yks-kanal-' + crypto.randomBytes(4).toString('hex');
    await query("INSERT INTO marketplace_channels (id, tenant_id, name, is_active, adapter_code) VALUES (?, ?, 'SofraMix', 0, 'soframix')", [kanal2, d2.id]);
    ok('K1: deneme + pasif kanal: koruma yok', (await js('/api/license/quote', { token: d2.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } })).d.korunanModuller.length === 0);
    // Korunan modul bagimlilik kuralina uyar: BASE secilmezse Masadan Siparis kalmaz
    const g3 = await kiraciKur({ ad: 'Bagimlilik', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'], bitis: bitisGun(10) });
    await gecmisKur(g3.id);
    const qg3 = (await js('/api/license/quote', { token: g3.token, body: { tier: 'TIER_6_10', modules: ['MENU_DIGITAL'] } })).d;
    ok('K1: yenilemede Adisyon ve Kasa birakilirsa Masadan Siparis korunmaz (bagimlilik)', qg3.korunanModuller.length === 0 && JSON.stringify(qg3.modules) === '["MENU_DIGITAL"]', qg3);

    console.log('\n=== 11) Karar 1: odeme gecmisi olmayan isletmenin ilk alimi ===');
    // "Kayit ol" ile acilan deneme: secilen kademeyle, 7 gun, KVKK onayli, odeme yok
    const kf1 = await kiraciKur({ ad: 'Kayit Formu', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK', 'MARKETPLACE'], bitis: bitisGun(7) });
    await query('UPDATE tenants SET kvkk_consent_at = ? WHERE id = ?', [new Date().toISOString(), kf1.id]);
    const ykf1 = (await js('/api/license/yenileme-kanali', { token: kf1.token })).d;
    ok('kayit formu denemesi: kanal deneme + ilk alim, donem "deneme"', ykf1.deneme === true && ykf1.ilkAlim === true && ykf1.donem.durum === 'deneme', ykf1);
    const qkf1 = (await js('/api/license/quote', { token: kf1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('kademe adina bakilmaz: tur ilk, kredi yok, korunan yok', qkf1.tur === 'ilk' && qkf1.krediTutari === 0 && qkf1.korunanModuller.length === 0, qkf1);
    const alkf1 = await js('/api/license/purchase', { token: kf1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    const onkf1 = await onayla(alkf1.d.id);
    const tkf1 = await kiraci(kf1.id);
    ok('ilk alim onayi: bugun + 365 (7 gunluk denemenin uzerine degil), Masadan Siparis korunmaz', onkf1.status === 200 && onkf1.d.tur === 'ilk'
        && yakin(tkf1.license_end_date, Date.now() + 365 * GUN) && ayniKume(JSON.parse(tkf1.license_modules), ['BASE', 'MENU_DIGITAL']), tkf1);
    ok('onaydan sonra odeme gecmisi var: sonraki talep ilk degil', (await js('/api/license/quote', { token: kf1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d.tur !== 'ilk');
    // Elle acilmis, odeme kaydi olmayan isletme (KVKK onayi yok): ilk alim, notr metin, root uyarisi
    const e1 = await kiraciKur({ ad: 'Elle Acilmis', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'], bitis: bitisGun(200) });
    const ye1 = (await js('/api/license/yenileme-kanali', { token: e1.token })).d;
    ok('elle acilmis odeme kaydi olmayan: ilk alim, "deneme" denmez, notr metin', ye1.ilkAlim === true && !ye1.deneme && /İlk paket alımınızda/.test(ye1.mesaj), ye1);
    const ale1 = await js('/api/license/purchase', { token: e1.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    const re1 = await rootKaydi(ale1.d.id);
    ok('root listesi: ilk alim, kalan 200 gun uyarisi, kalkacak Masadan Siparis', ale1.d.tur === 'ilk' && re1.etkin_tur === 'ilk' && re1.ilk_alim_kalan_gun === 200
        && JSON.stringify(re1.kalkacak_moduller) === '["QR_SIPARIS"]', re1);
    // 0 TL onayli kayit odeme gecmisi sayilmaz; islenmis SofraMix provizyonu sayilir
    const z1 = await kiraciKur({ ad: 'Sifir Kayit', tier: 'TIER_6_10', moduller: ['BASE'], bitis: bitisGun(100) });
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 0, 'onaylandi', ?, datetime('now'), 365)`, ['yks-sifir-' + crypto.randomBytes(4).toString('hex'), z1.id, bitisGun(100)]);
    ok('0 TL onayli kayit odeme gecmisi sayilmaz (ilk)', (await js('/api/license/quote', { token: z1.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } })).d.tur === 'ilk');
    await query("INSERT INTO pos_provizyon (id, odeme_id, tenant_id, tutar_kurus, durum) VALUES (?, ?, ?, 1200000, 'islendi')", ['yks-pv-' + crypto.randomBytes(4).toString('hex'), 'yks-pv-' + crypto.randomBytes(4).toString('hex'), z1.id]);
    ok('islenmis SofraMix provizyonu odeme gecmisi sayilir (ilk degil)', (await js('/api/license/quote', { token: z1.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } })).d.tur !== 'ilk');
    await query('DELETE FROM pos_provizyon WHERE tenant_id = ?', [z1.id]);
    // Deploy oncesi (tur yazilmamis) bekleyen kayit, odeme gecmisi yok: onayda ilk alim gibi
    const o1 = await kiraciKur({ ad: 'Eski Ilk', tier: 'TIER_6_10', moduller: ['BASE'], bitis: bitisGun(5) });
    const eskiIlk = 'yks-eskiilk-' + crypto.randomBytes(4).toString('hex');
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum) VALUES (?, ?, 'TIER_6_10', '["BASE"]', 4000, 'beklemede')`, [eskiIlk, o1.id]);
    const ono1 = await onayla(eskiIlk);
    ok('tur yazilmamis kayit + odeme gecmisi yok: onay gununden 365 (ilk)', ono1.status === 200 && ono1.d.tur === 'ilk'
        && yakin((await kiraci(o1.id)).license_end_date, Date.now() + 365 * GUN), ono1.d);

    console.log('\n=== 12) Karar 5: KAPALI isletme yalniz lisansini yeniler ===');
    const kp = await kiraciKur({ ad: 'Kapali', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitis: new Date(Date.now() - 10 * GUN).toISOString() });
    await gecmisKur(kp.id);
    ok('KAPALI isletmede sahip girisi 200', kp.girisDurumu === 200 && !!kp.token, kp.girisDurumu);
    const kasaEposta = `${EPOSTA_ON}kasa-${kp.slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), kp.id, kasaEposta, await bcrypt.hash('kasa1234', 4), 'Kasa', 'CASHIER', new Date().toISOString()]);
    const kg = await js('/api/auth/login', { body: { email: kasaEposta, businessCode: kp.kod, password: 'kasa1234' } });
    ok('KAPALI isletmede kasiyer girisi 403 LICENSE_EXPIRED (anlamli mesaj)', kg.status === 403 && kg.d.code === 'LICENSE_EXPIRED' && /sahibi ya da müdür/.test(kg.d.message), kg);
    const kme = await js('/api/auth/me', { token: kp.token });
    ok('oturum bilgisi acik, lisans durumu KAPALI', kme.status === 200 && kme.d.lisansDurum === 'KAPALI', kme.d && kme.d.lisansDurum);
    for (const [m, yol] of [['GET', '/api/orders'], ['GET', '/api/tables'], ['GET', '/api/tenant/me'], ['GET', '/api/plaka/durum'], ['GET', '/api/products'], ['POST', '/api/tables']]) {
        const x = await js(yol, { token: kp.token, method: m, body: m === 'POST' ? { code: 'X1', name: 'X1' } : undefined });
        ok(`KAPALI: ${m} ${yol} 403 LICENSE_EXPIRED + Lisans sayfasi mesaji`, x.status === 403 && x.d.code === 'LICENSE_EXPIRED' && /Lisans sayfasına gidin/.test(x.d.message), x);
    }
    ok('KAPALI: yonetici sifresi kapisi acik (manager-status 200)', (await js('/api/auth/manager-status', { token: kp.token })).status === 200);
    ok('KAPALI: yenileme kanali 200 (donem yenileme)', ((x) => x.status === 200 && x.d.donem.durum === 'yenileme')(await js('/api/license/yenileme-kanali', { token: kp.token })));
    ok('KAPALI: oturumlu teklif 200', (await js('/api/license/quote', { token: kp.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).status === 200);
    const kal = await js('/api/license/purchase', { token: kp.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('KAPALI: satin alma talebi 201 (yenileme)', kal.status === 201 && kal.d.tur === 'yenileme', kal);
    ok('KAPALI: gecmis 200, "odemeyi yaptim" 200', (await js('/api/license/purchases', { token: kp.token })).status === 200
        && (await js(`/api/license/purchases/${kal.d.id}/mark-paid`, { token: kp.token, body: { paymentRef: 'dekont' } })).status === 200);
    ok('KAPALI: bekleyen bildirimi iptal 200', (await js(`/api/license/purchases/${kal.d.id}/cancel`, { token: kp.token, method: 'POST' })).status === 200);
    const kal2 = await js('/api/license/purchase', { token: kp.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    await onayla(kal2.d.id);
    ok('onaydan sonra program acilir (siparis listesi 200)', (await js('/api/orders', { token: kp.token })).status === 200);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
