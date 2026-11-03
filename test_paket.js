// PAKET SERVIS: telefon siparisi (olustur, kalem, bilgi duzenle, durum, odeme + kapanis, iptal yetkisi, paket no),
// kiraci izolasyonu, MARKETPLACE modulu olmadan calisma, SofraMix siparisi (listede gorunme, musteri bilgisi,
// aksiyonun adaptore gitmesi, gecis kurali, teslimde tek seferlik otomatik odeme, maskeli adresin silinmesi,
// platform hata mesaji), SSE uyarisi, mutfak etiketi, 30 gun KVKK temizligi (olay kutusu yukleri dahil), rapor kirilimi,
// musteri defteri (bulma, tekillik, unutma, 365 gun, kiraci izolasyonu), teslimat ucreti (ayri kalem, odenenin altina inmez),
// yerelde kapali siparise gelen olay (kapanis/ciro/odeme degismez), ilk kez teslim gorulen siparis, yerelde kapat,
// kapanis guvenligi (iptal edilen kapanmaz, esanli kapatma), ayrilmis kanal adlari, liste siniri (acik siparis kesilmez).
// Sahte SofraMix bu testin icinde kosar (ag yok). Calistir: node test_paket.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const KVKK = require('./src/services/paketKvkk');

const PORT = 45975, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const SMX_PORT = 45976, SMX = `http://127.0.0.1:${SMX_PORT}`;
const GIZLI = 'test-gizli-anahtar-1234567890';
const SMX_ANAHTAR = 'smx_paket_test_anahtari_1';
const AD_A = 'Paket Test Lokanta', AD_B = 'Paket Test Komsu';
const NO_A = 779301, NO_B = 779302;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
async function bekle(kosul, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const r = await kosul().catch(() => null); if (r) return r; await uyu(250); }
    return null;
}

function govde(isletmeNo, ad, x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: isletmeNo, isletme_slug: 'paket-test-' + isletmeNo, isletme_adi: ad,
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Paket Sahibi', yetkili_email: `paket-sahibi-${isletmeNo}@ornek.test`, yetkili_tel: '0532111' + String(isletmeNo).slice(-4),
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
    const t = await query('SELECT id FROM tenants WHERE business_name IN (?, ?)', [AD_A, AD_B]);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'stock_movements', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories',
                          'marketplace_events', 'marketplace_sync_state', 'marketplace_commands', 'marketplace_product_map',
                          'marketplace_store_links', 'marketplace_credentials', 'marketplace_channels', 'license_cache', 'islem_gunlugu',
                          'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'push_abonelikleri', 'paket_musterileri', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query('DELETE FROM deneme_kayitlari WHERE soframix_business_id IN (?, ?)', [String(NO_A), String(NO_B)]);
    await query('DELETE FROM deneme_devir_nonce WHERE isletme_no IN (?, ?)', [String(NO_A), String(NO_B)]);
}

// --- Sahte SofraMix (gercek yanit sekli: routes/business.js + common.js orderWithItems) ---
const smxSiparis = new Map();
const smxGelen = [];
let smxSaat = 0, smxAnahtarIptal = false;
function smxZaman() {
    const t = Math.max(Date.now(), smxSaat + 1000);
    smxSaat = t;
    return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}
function smxYeni(id, x = {}) {
    const z = smxZaman();
    const o = {
        id, code: 'SMX-' + ('AB' + id).slice(-6), status: 'yeni', delivery_type: 'isletme_kurye',
        payment_method: 'kapida_nakit', payment_status: 'bekliyor',
        customer_name: 'Zeynep Kaya', customer_phone: '05551234567',
        address: { district: 'Merkez', full_address: 'Dumlupinar Mah. 12/4', note: 'Kapida zil yok' },
        customer_note: 'Acisiz olsun', items_total_kurus: 25000, delivery_fee_kurus: 1500, total_kurus: 26500,
        kampanya_indirim_kurus: 0, kampanya_baslik: '', created_at: z, updated_at: z,
        items: [
            { id: id * 10 + 1, product_id: 5, name: 'Adana Durum', qty: 2, unit_price_kurus: 10000, total_kurus: 20000, note: '', options: [{ secenek: 'Acili' }] },
            { id: id * 10 + 2, product_id: 6, name: 'Ayran', qty: 2, unit_price_kurus: 2500, total_kurus: 5000, note: '', options: [] },
        ],
        ...x,
    };
    smxSiparis.set(String(id), o);
    return o;
}
const smxIzin = (o) => ({
    yeni: ['onaylandi', 'iptal'], onaylandi: ['hazirlaniyor', 'iptal'],
    hazirlaniyor: [o.delivery_type === 'gel_al' ? 'hazir' : 'yolda', 'iptal'], yolda: ['teslim'], hazir: ['teslim'],
}[o.status] || []);
function govdeOku(req) { return new Promise((r) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (_) { r({}); } }); }); }
const smx = http.createServer(async (req, res) => {
    const u = new URL(req.url, SMX);
    const json = (kod, g) => { res.writeHead(kod, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(g)); };
    if (req.headers['x-smx-anahtar'] !== SMX_ANAHTAR || smxAnahtarIptal) return json(401, { error: 'Anahtar gecersiz' });
    if (u.pathname === '/api/business/orders' && req.method === 'GET') {
        const esik = (u.searchParams.get('degisen_sonra') || '').slice(0, 19).replace('T', ' ');
        const liste = [...smxSiparis.values()].filter((o) => !o.gizli && (!esik || o.updated_at >= esik));
        return json(200, { orders: liste.map((o) => { const k = JSON.parse(JSON.stringify(o)); delete k.gizli; return k; }) });
    }
    let m = u.pathname.match(/^\/api\/business\/orders\/(\d+)\/status$/);
    if (m && req.method === 'POST') {
        const b = await govdeOku(req);
        smxGelen.push({ yol: 'status', id: m[1], govde: b });
        const o = smxSiparis.get(m[1]);
        if (!o) return json(404, { error: 'Sipariş bulunamadı' });
        if (o.status === b.status) return json(200, { ok: true, status: b.status, zaten: true });
        if (!smxIzin(o).includes(b.status)) return json(400, { error: `"${o.status}" durumundan "${b.status}" durumuna geçilemez` });
        o.status = b.status; o.updated_at = smxZaman();
        if (b.status === 'iptal') o.cancel_reason = b.reason;
        if (b.status === 'teslim' && o.payment_method !== 'online_iyzico') o.payment_status = 'odendi';
        return json(200, { ok: true, status: o.status });
    }
    m = u.pathname.match(/^\/api\/business\/orders\/(\d+)\/teslim-edilemedi$/);
    if (m && req.method === 'POST') {
        const b = await govdeOku(req);
        smxGelen.push({ yol: 'teslim-edilemedi', id: m[1], govde: b });
        const o = smxSiparis.get(m[1]);
        if (!o) return json(404, { error: 'Sipariş bulunamadı' });
        if (!['yolda', 'hazir'].includes(o.status)) return json(400, { error: 'Yalnız yoldaki veya teslim alınmayı bekleyen sipariş için bildirilebilir' });
        if (o.teslim_sorunu_at) return json(409, { error: 'Bu sipariş için zaten bildirim yapıldı - yönetim inceliyor' });
        o.teslim_sorunu_at = smxZaman(); o.updated_at = o.teslim_sorunu_at;
        return json(200, { ok: true });
    }
    if (u.pathname === '/api/business/menu') return json(200, { categories: [], products: [] });
    json(404, { error: 'yok' });
});

(async () => {
    initDb(); await uyu(900); await temizle();
    await new Promise((r) => smx.listen(SMX_PORT, '127.0.0.1', r));
    // Cekme dongusu 1 sn'de bir: SofraMix siparisi gercek yoldan (sunucunun kendi dongusu) duser.
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL, SIPARIS_CEKME_ARALIK_SN: '1',
               SOFRAMIX_PLATFORM_URL: '', SOFRAMIX_PLATFORM_ANAHTAR: '',
               JWT_SECRET: 'paket-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} try { smx.close(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== 1) Hazirlik: iki isletme + personel + menu ===');
    const devir = async (no, ad) => {
        const r = await fetch(baglanti(govde(no, ad)), { redirect: 'manual' });
        const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
        return (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    };
    const sahip = await devir(NO_A, AD_A);
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tid = me.tenantId;
    ok('A isletmesi acildi', !!tid && !!sahip.token, me);
    const giris = async (email, pw) => (await js('/api/auth/login', { body: { email, businessCode: me.businessCode, password: pw } })).d;
    const personel = [['p-kasiyer@ornek.test', 'kasiyer123', 'Kasiyer Ayse', 'CASHIER'], ['p-garson@ornek.test', 'garson123', 'Garson Veli', 'WAITER'],
                      ['p-mutfak@ornek.test', 'mutfak123', 'Usta Hasan', 'KITCHEN'], ['p-mudur@ornek.test', 'mudur123', 'Mudur Can', 'MANAGER']];
    for (const [email, password, name, role] of personel) await js('/api/auth/staff', { token: sahip.token, body: { email, password, name, role } });
    const kasiyer = await giris('p-kasiyer@ornek.test', 'kasiyer123');
    const garson = await giris('p-garson@ornek.test', 'garson123');
    const mutfak = await giris('p-mutfak@ornek.test', 'mutfak123');
    const mudur = await giris('p-mudur@ornek.test', 'mudur123');
    ok('personel girisleri', !!(kasiyer.token && garson.token && mutfak.token && mudur.token));
    const kat = (await js('/api/categories', { token: sahip.token, body: { name: 'Pide' } })).d;
    const lahmacun = (await js('/api/products', { token: sahip.token, body: { name: 'Lahmacun', price: 120, categoryId: kat.id, isAvailable: true } })).d;
    const ayran = (await js('/api/products', { token: sahip.token, body: { name: 'Ayran', price: 30, categoryId: kat.id, isAvailable: true, tracksStock: true, stockQty: 50 } })).d;
    const m1 = (await js('/api/tables', { token: sahip.token, body: { code: 'M1', name: 'Masa 1', section: 'Salon' } })).d;
    // MARKETPLACE modulu YOK: Paket Servis temel pakette calismali
    await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [tid]);
    const sahipB = await devir(NO_B, AD_B);
    const tidB = (await js('/api/auth/me', { token: sahipB.token })).d.tenantId;
    ok('B isletmesi acildi', !!tidB && tidB !== tid);

    console.log('\n=== 2) Yetki ve modul ===');
    ok('oturumsuz 401', (await js('/api/paket')).status === 401);
    ok('mutfak hesabi (KITCHEN) goremez 403', (await js('/api/paket', { token: mutfak.token })).status === 403);
    const l0 = await js('/api/paket', { token: sahip.token });
    ok('MARKETPLACE modulu olmadan liste 200', l0.status === 200 && Array.isArray(l0.d.siparisler), l0);
    ok('garson (WAITER) paket goremez 403 (Patron karari)', (await js('/api/paket', { token: garson.token })).status === 403);
    ok('garson paket acamaz 403', (await js('/api/paket', { token: garson.token, body: { musteriAd: 'X', teslimat: 'GEL_AL' } })).status === 403);
    ok('garson musteri defterine de bakamaz 403', (await js('/api/paket/musteri/bul', { token: garson.token, body: { tel: '05321112233' } })).status === 403);
    const mp0 = await js('/api/marketplace/orders', { token: sahip.token });
    ok('(karsilastirma) pazaryeri ucu modulsuz 403', mp0.status === 403 && mp0.d.code === 'MODULE_NOT_LICENSED', mp0);

    console.log('\n=== 3) Telefon siparisi olusturma ===');
    const yeni = (b, tok = kasiyer.token) => js('/api/paket', { token: tok, body: b });
    ok('ad da telefon da yoksa 400', (await yeni({ teslimat: 'GEL_AL' })).status === 400);
    ok('adrese teslimde adres yoksa 400', (await yeni({ musteriAd: 'X', teslimat: 'ADRES' })).status === 400);
    ok('gecersiz odeme sekli 400', (await yeni({ musteriAd: 'X', teslimat: 'GEL_AL', odemeSekli: 'online_iyzico' })).status === 400);
    ok('gecersiz teslimat 400', (await yeni({ musteriAd: 'X', teslimat: 'KARGO' })).status === 400);
    ok('gecersiz telefon 400', (await yeni({ musteriTel: 'abc', teslimat: 'GEL_AL' })).status === 400);
    const p1r = await yeni({ musteriAd: 'Ayşe Yılmaz', musteriTel: '0532 111 22 33', musteriAdres: 'Cumhuriyet Mah. 5. Sok. No:3',
                             not: 'Zil bozuk, arayın', teslimat: 'ADRES', odemeSekli: 'kapida_nakit' });
    const p1 = p1r.d;
    ok('P1 acildi (201): Paket 1, telefon, hazirlaniyor', p1r.status === 201 && p1.paketNo === 1 && p1.etiket === 'Paket 1'
        && p1.kaynak === 'TELEFON' && p1.asama === 'HAZIRLANIYOR' && p1.grup === 'hazirlaniyor', p1r);
    ok('P1 musteri + odeme + teslimat', p1.musteri && p1.musteri.ad === 'Ayşe Yılmaz' && p1.musteri.tel === '0532 111 22 33'
        && p1.odeme.etiket === 'Kapıda nakit' && p1.teslimat === 'ADRES' && p1.teslimatEtiket === 'Adrese teslim' && p1.not === 'Zil bozuk, arayın', p1);
    ok('P1 aksiyonlar: Yola cikti + Iptal (yalniz yonetici)', p1.aksiyonlar.map(a => a.kod).join(',') === 'yolda,iptal'
        && p1.aksiyonlar.find(a => a.kod === 'iptal').yalnizYonetici === true && p1.duzenlenebilir === true, p1.aksiyonlar);
    const p2 = (await yeni({ musteriAd: 'Mehmet', teslimat: 'GEL_AL', odemeSekli: 'kapida_kart' })).d;
    ok('P2: Paket 2, gel-al -> Hazir dugmesi', p2.paketNo === 2 && p2.teslimat === 'GEL_AL' && p2.aksiyonlar[0].kod === 'hazir' && p2.odeme.etiket === 'Kapıda kart', p2);
    const pB = (await js('/api/paket', { token: sahipB.token, body: { musteriTel: '05000000000', teslimat: 'GEL_AL' } })).d;
    ok('B isletmesinde numara 1den baslar', pB.paketNo === 1, pB);
    const gen = await js('/api/orders', { token: kasiyer.token, body: { channel: 'PAKET_SERVIS' } });
    const gen2 = await js('/api/orders', { token: kasiyer.token, body: { channel: 'paket_servis' } });
    ok('genel siparis ucundan paket kanali acilamaz (400, buyuk/kucuk harf)', gen.status === 400 && gen2.status === 400, [gen, gen2]);
    ok('telefon siparisinin kanal kodu PAKET_SERVIS (elle acilan "PAKET" kanaliyla karismaz)',
        (await query('SELECT channel FROM orders WHERE id = ?', [p1.id])).rows[0].channel === 'PAKET_SERVIS');
    // Esanli 5 siparis: gunluk paket no tekil ve ardisik kalmali (yazma kilidi + UNIQUE indeks)
    const esZaman = await Promise.all([1, 2, 3, 4, 5].map((i) => yeni({ musteriAd: 'Esanli ' + i, teslimat: 'GEL_AL' })));
    const nolar = esZaman.map(r => r.d && r.d.paketNo).sort((a, b) => a - b);
    ok('esanli acilista paket no tekil ve ardisik (3..7)', esZaman.every(r => r.status === 201) && nolar.join(',') === '3,4,5,6,7', nolar);
    for (const r of esZaman) await js(`/api/paket/${r.d.id}/iptal`, { token: mudur.token, body: {} });

    console.log('\n=== 4) Kalemler (masadaki ayni uclar) + mutfak etiketi ===');
    await js(`/api/orders/${p1.id}/items`, { token: kasiyer.token, body: { productId: lahmacun.id, qty: 2 } });
    await js(`/api/orders/${p1.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } });
    const g1 = (await js('/api/paket/' + p1.id, { token: kasiyer.token })).d;
    ok('P1 toplam 270, 2 kalem', g1.toplam === 270 && g1.kalemler.length === 2 && g1.kalan === 270, g1);
    const kq = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d;
    const kp1 = kq.kartlar.find(k => k.orderId === p1.id);
    ok('mutfakta "Paket 1" karti (masa adi bos, teslimat yazili)', kp1 && kp1.etiket === 'Paket 1' && !kp1.tableName && kp1.teslimat === 'Adrese teslim', kp1);
    const gk = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: garson.token })).d;
    ok('garson uygulamasi paket siparisini GORMEZ (kuyrukta yok)', gk && !gk.kartlar.some(k => k.orderId === p1.id), gk && gk.kartlar.map(k => k.etiket));
    // KVKK: genel siparis uclari her role acik -> musteri ad/telefon/adres DONMEZ
    const kisiselYok = (o) => o && !('musteri_ad' in o) && !('musteri_tel' in o) && !('musteri_adres' in o);
    const ko = await js('/api/orders?channel=PAKET_SERVIS', { token: mutfak.token });
    ok('mutfak /api/orders?channel=PAKET_SERVIS: siparis var ama musteri alanlari YOK', ko.status === 200 && ko.d.some(o => o.id === p1.id) && ko.d.every(kisiselYok), ko.d && ko.d[0]);
    const go1 = await js('/api/orders/' + p1.id, { token: garson.token });
    const ko1 = await js('/api/orders/' + p1.id, { token: mutfak.token });
    ok('garson ve mutfak /api/orders/:id: musteri alanlari YOK', go1.status === 200 && kisiselYok(go1.d) && ko1.status === 200 && kisiselYok(ko1.d), [go1.d && Object.keys(go1.d)]);
    ok('kasiyer de genel uctan goremez (bilgi yalniz Paket Servis ucunda)', kisiselYok((await js('/api/orders/' + p1.id, { token: kasiyer.token })).d)
        && (await js('/api/paket/' + p1.id, { token: kasiyer.token })).d.musteri.tel === '0532 111 22 33');

    console.log('\n=== 5) Bilgi duzenleme ===');
    const d1 = await js('/api/paket/' + p1.id, { token: kasiyer.token, method: 'PUT', body: { musteriAdres: 'Yeni Mah. 7. Sok. No:1' } });
    ok('adres degisti, digerleri korundu', d1.status === 200 && d1.d.musteri.adres === 'Yeni Mah. 7. Sok. No:1' && d1.d.musteri.ad === 'Ayşe Yılmaz' && d1.d.odeme.kod === 'kapida_nakit', d1);
    ok('gecersiz duzenleme 400', (await js('/api/paket/' + p1.id, { token: kasiyer.token, method: 'PUT', body: { teslimat: 'ADRES', musteriAdres: '' } })).status === 400);

    console.log('\n=== 6) Durum gecisleri ===');
    const aks = (id, aksiyon, tok = kasiyer.token, sebep) => js(`/api/paket/${id}/aksiyon`, { token: tok, body: { aksiyon, sebep } });
    ok('hazirlanirken teslim edildi olmaz (409)', (await aks(p1.id, 'teslim')).status === 409);
    ok('adrese teslimde "hazir" olmaz (409)', (await aks(p1.id, 'hazir')).status === 409);
    const bosHazir = await aks(p2.id, 'hazir');
    ok('urunsuz sipariste hazir olmaz (409, Turkce mesaj)', bosHazir.status === 409 && /ürün yok/.test(bosHazir.d.message), bosHazir);
    ok('gecersiz islem 409', (await aks(p1.id, 'ucur')).status === 409);
    const y1 = await aks(p1.id, 'yolda');
    ok('P1 yola cikti: YOLDA + zaman damgasi', y1.status === 200 && y1.d.siparis.asama === 'YOLDA' && !!y1.d.siparis.yolaCikis && y1.d.siparis.grup === 'yolda', y1);
    const kq2 = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d;
    ok('yola cikinca mutfak kartindan dustu', !kq2.kartlar.some(k => k.orderId === p1.id), kq2.kartlar.map(k => k.etiket));
    ok('yola ciktiktan sonra bilgi degismez (409)', (await js('/api/paket/' + p1.id, { token: kasiyer.token, method: 'PUT', body: { musteriAd: 'B' } })).status === 409);
    ok('ikinci kez yola cikti 409', (await aks(p1.id, 'yolda')).status === 409);
    const yoldaEkle = await js(`/api/orders/${p1.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } });
    ok('yola cikan pakete urun EKLENEMEZ (409, mutfak karti yeniden acilmaz)', yoldaEkle.status === 409 && /eklenemez/.test(yoldaEkle.d.message), yoldaEkle);
    const p1Kalem = (await js(`/api/orders/${p1.id}`, { token: kasiyer.token })).d.items.find(i => i.product_id === lahmacun.id);
    ok('yola cikan pakette adet ARTIRILAMAZ (409)', (await js(`/api/orders/${p1.id}/items/${p1Kalem.id}`, { token: kasiyer.token, method: 'PUT', body: { qty: 3 } })).status === 409);
    ok('mutfak karti yeniden acilmadi', !(await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d.kartlar.some(k => k.orderId === p1.id));
    const erkenKapat = await js(`/api/orders/${p1.id}/close`, { token: kasiyer.token, body: {} });
    ok('teslimden once hesap kapatilamaz (409 PAKET_TESLIM_YOK)', erkenKapat.status === 409 && erkenKapat.d.code === 'PAKET_TESLIM_YOK', erkenKapat);

    console.log('\n=== 7) Teslim + odeme + kapanis ===');
    const t1 = await aks(p1.id, 'teslim');
    ok('P1 teslim: odeme yok -> acik kalir, "Odeme bekliyor"', t1.status === 200 && t1.d.kapandi === false && t1.d.siparis.asama === 'TESLIM'
        && t1.d.siparis.grup === 'odeme' && !!t1.d.siparis.teslimAt, t1);
    const teslimEkle = await js(`/api/orders/${p1.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } });
    ok('teslim edilmis (odeme bekleyen) pakete de urun EKLENEMEZ (409)', teslimEkle.status === 409 && /eklenemez/.test(teslimEkle.d.message), teslimEkle);
    const it1 = (await js(`/api/orders/${p1.id}`, { token: kasiyer.token })).d.items;
    const by = await js('/api/payments/by-items', { token: kasiyer.token, body: { orderId: p1.id, method: 'NAKIT', items: it1.map(i => ({ itemId: i.id, qty: i.qty })) } });
    ok('kalem bazli tahsilat (mevcut odeme ekrani)', by.status === 201 && by.d.amount === 270, by);
    const k1 = await js(`/api/orders/${p1.id}/close`, { token: kasiyer.token, body: {} });
    ok('teslimden sonra Hesabi Kapat 200', k1.status === 200, k1);
    const g1b = (await js('/api/paket/' + p1.id, { token: kasiyer.token })).d;
    ok('P1 tamamlandi (bugun grubunda)', g1b.durum === 'CLOSED' && g1b.asama === 'KAPANDI' && g1b.grup === 'bugun' && g1b.odenen === 270, g1b);
    // P2: once odeme (teslimden ONCE), sonra hazir + teslim -> hesap kendiliginden kapanir
    await js(`/api/orders/${p2.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 2 } });
    const onOdeme = await js('/api/payments', { token: kasiyer.token, body: { orderId: p2.id, method: 'KREDI_KARTI', amount: 60 } });
    ok('teslimden once odeme alinabilir', onOdeme.status === 201, onOdeme);
    ok('P2 hazir', (await aks(p2.id, 'hazir')).d.siparis.asama === 'HAZIR');
    ok('hazir (gel-al) pakete urun eklenemez (409)', (await js(`/api/orders/${p2.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } })).status === 409);
    const t2 = await aks(p2.id, 'teslim');
    ok('P2 teslim: odeme tamam -> hesap KENDILIGINDEN kapandi', t2.status === 200 && t2.d.kapandi === true && t2.d.siparis.durum === 'CLOSED', t2);
    const stok = (await query("SELECT COUNT(*) AS c, SUM(qty) AS q FROM stock_movements WHERE ref_id = ? AND kind = 'OUT'", [p2.id])).rows[0];
    const kalanStok = (await query('SELECT stock_qty FROM products WHERE id = ?', [ayran.id])).rows[0].stock_qty;
    ok('otomatik kapanista stok dusumu (masadaki kapanisla ayni yol): 50 - 1 (P1) - 2 (P2) = 47', stok.c === 1 && stok.q === 2 && kalanStok === 47, [stok, kalanStok]);
    ok('kapanan sipariste aksiyon kalmaz', t2.d.siparis.aksiyonlar.length === 0);

    console.log('\n=== 8) Iptal yetkisi + islem gunlugu ===');
    const p3 = (await yeni({ musteriTel: '05321234567', teslimat: 'GEL_AL' })).d;
    await js(`/api/orders/${p3.id}/items`, { token: kasiyer.token, body: { productId: lahmacun.id, qty: 1 } });
    ok('Paket 8 (esanli 5 siparisten sonra)', p3.paketNo === 8, p3.paketNo);
    const iptal = (id, tok, sebep) => js(`/api/paket/${id}/iptal`, { token: tok, body: { sebep } });
    ok('kasiyer dolu siparisi iptal edemez (403)', (await iptal(p3.id, kasiyer.token)).status === 403);
    ok('garson iptal edemez (403)', (await iptal(p3.id, garson.token)).status === 403);
    ok('/aksiyon ile iptal yok (400)', (await aks(p3.id, 'iptal', mudur.token)).status === 400);
    const ip3 = await iptal(p3.id, mudur.token, 'Musteri vazgecti');
    const g3 = (await js('/api/paket/' + p3.id, { token: mudur.token })).d;
    ok('mudur iptal eder -> IPTAL', ip3.status === 200 && g3.durum === 'CANCELLED' && g3.asama === 'IPTAL', [ip3, g3.durum]);
    const gl3 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND hedef_id = ? AND islem = 'siparis_iptal'", [tid, p3.id])).rows[0];
    ok('islem gunlugune yazildi (kim + Paket 8 + sebep)', gl3 && gl3.user_name === 'Mudur Can' && /Paket 8/.test(gl3.detay) && /Musteri vazgecti/.test(gl3.detay), gl3);
    ok('iptal edilen tekrar iptal edilemez (409)', (await iptal(p3.id, mudur.token)).status === 409);
    const p4 = (await yeni({ musteriAd: 'Yanlis Acilan', teslimat: 'GEL_AL' })).d;
    const ip4 = await iptal(p4.id, kasiyer.token);
    ok('BOS siparisi kasiyer de silebilir (yanlislikla acilan)', ip4.status === 200, ip4);
    const gl4 = (await query("SELECT detay FROM islem_gunlugu WHERE hedef_id = ?", [p4.id])).rows[0];
    ok('bos iptal de gunlukte', gl4 && /boş sipariş/.test(gl4.detay), gl4);

    console.log('\n=== 8b) Kapanis guvenligi: iptal edilen kapanmaz, esanli kapatmada stok bir kez duser ===');
    await query("UPDATE orders SET paket_durum = 'TESLIM' WHERE id = ?", [p3.id]);   // bayat odeme penceresi senaryosu
    const iptalKapat = await js(`/api/orders/${p3.id}/close`, { token: kasiyer.token, body: {} });
    ok('iptal edilmis paket bayat pencereden KAPATILAMAZ (409)', iptalKapat.status === 409
        && (await query('SELECT status FROM orders WHERE id = ?', [p3.id])).rows[0].status === 'CANCELLED', iptalKapat);
    const p9 = (await yeni({ musteriAd: 'Esanli Kapanis', teslimat: 'GEL_AL' })).d;
    await js(`/api/orders/${p9.id}/items`, { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } });
    await aks(p9.id, 'hazir'); await aks(p9.id, 'teslim');
    const it9 = (await js(`/api/orders/${p9.id}`, { token: kasiyer.token })).d.items;
    await js('/api/payments/by-items', { token: kasiyer.token, body: { orderId: p9.id, method: 'NAKIT', items: it9.map(i => ({ itemId: i.id, qty: i.qty })) } });
    const stokOnce = (await query('SELECT stock_qty FROM products WHERE id = ?', [ayran.id])).rows[0].stock_qty;
    const [c1, c2] = await Promise.all([js(`/api/orders/${p9.id}/close`, { token: kasiyer.token, body: {} }), js(`/api/orders/${p9.id}/close`, { token: mudur.token, body: {} })]);
    const hareket = (await query("SELECT COUNT(*) AS c FROM stock_movements WHERE ref_id = ? AND kind = 'OUT'", [p9.id])).rows[0].c;
    const stokSonra = (await query('SELECT stock_qty FROM products WHERE id = ?', [ayran.id])).rows[0].stock_qty;
    ok('esanli iki kapatma: biri kapatir, digeri kapatmaz; stok TEK kez duser', [c1.status, c2.status].includes(200) && hareket === 1 && stokSonra === stokOnce - 1,
        [c1.status, c2.status, c1.d && c1.d.message, c2.d && c2.d.message, hareket, stokOnce, stokSonra]);

    console.log('\n=== 9) Kiraci izolasyonu ===');
    ok('B, A siparisini goremez (404)', (await js('/api/paket/' + p1.id, { token: sahipB.token })).status === 404);
    ok('B, A siparisini duzenleyemez (404)', (await js('/api/paket/' + p3.id, { token: sahipB.token, method: 'PUT', body: { musteriAd: 'x' } })).status === 404);
    ok('B, A siparisinde aksiyon yapamaz (404)', (await js(`/api/paket/${p1.id}/aksiyon`, { token: sahipB.token, body: { aksiyon: 'teslim' } })).status === 404);
    ok('B, A siparisini iptal edemez (404)', (await js(`/api/paket/${p4.id}/iptal`, { token: sahipB.token, body: {} })).status === 404);
    const lb = (await js('/api/paket', { token: sahipB.token })).d;
    const la = (await js('/api/paket', { token: sahip.token })).d;
    ok('listeler birbirine karismaz', lb.siparisler.length === 1 && lb.siparisler[0].id === pB.id && !la.siparisler.some(s => s.id === pB.id), lb.siparisler.map(s => s.etiket));
    ok('masa siparisi paket ucundan okunmaz (404)', (await js('/api/paket/' + (await js('/api/orders', { token: kasiyer.token, body: { tableId: m1.id } })).d.id, { token: kasiyer.token })).status === 404);

    console.log('\n=== 10) SofraMix siparisi Paket Servis ekraninda ===');
    const kanalId = uuid();
    await query(`INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, is_active, is_api_enabled) VALUES (?, ?, 'SofraMix', 'soframix', 1, 1)`, [kanalId, tid]);
    const cred = await require('./src/marketplace/core/credentialStore').saveCredentials({
        tenantId: tid, channelId: kanalId, scope: 'store', scopeRef: String(NO_A), fields: { apiKey: SMX_ANAHTAR, apiBase: SMX } });
    await query(`INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, credential_id, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
        [uuid(), tid, kanalId, String(NO_A), cred.id]);
    const olaylar = [];
    const abc = new AbortController();
    fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(sahip.token), { signal: abc.signal })
        .then(async (res) => { const rd = res.body.getReader(); const td = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; olaylar.push(td.decode(value)); } }).catch(() => {});
    await uyu(600);
    smxYeni(9001);
    const smxBul = async (ref, tok = kasiyer.token) => { const l = (await js('/api/paket', { token: tok })).d; return l.siparisler.find(s => s.harici && s.harici.ref === String(ref)); };
    const s1 = await bekle(() => smxBul(9001));
    ok('SofraMix siparisi cekme dongusuyle listeye dustu (modul YOK)', !!s1, s1);
    ok('etiket "SofraMix SMX-..." + kaynak (rozet kanal adindan) + onay bekliyor + dikkat', s1 && s1.etiket === 'SofraMix SMX-AB9001'
        && s1.kaynak === 'PAZARYERI' && s1.kaynakAd === 'SofraMix' && s1.kanal === 'soframix' && s1.asama === 'YENI' && s1.dikkat === true, s1);
    ok('musteri adi/telefon/adres (tarifle) saklandi', s1 && s1.musteri && s1.musteri.ad === 'Zeynep Kaya' && s1.musteri.tel === '05551234567'
        && s1.musteri.adres === 'Dumlupinar Mah. 12/4, Merkez (Tarif: Kapida zil yok)', s1 && s1.musteri);
    ok('odeme "Kapida nakit", toplam 265, 2 kalem, not', s1 && s1.odeme.etiket === 'Kapıda nakit' && s1.toplam === 265 && s1.kalemler.length === 2 && s1.not === 'Acisiz olsun', s1);
    ok('dugmeler gecis matrisinden: Onayla + Reddet', s1 && s1.aksiyonlar.map(a => a.kod + ':' + a.etiket).join(',') === 'kabul:Onayla,iptal:Reddet', s1 && s1.aksiyonlar);
    await uyu(300);
    const sseMetin = olaylar.join('');
    const paketOlay = sseMetin.split('\n\n').filter(f => f.includes('event: paket_siparis') && f.includes(s1.id));
    ok('kasaya SSE uyarisi (paket_siparis, PAZARYERI/SofraMix, zil icin dikkat + gelis durumu)', paketOlay.length === 1 && /"kaynak":"PAZARYERI"/.test(paketOlay[0])
        && /"kaynakAd":"SofraMix"/.test(paketOlay[0]) && /"dikkat":true/.test(paketOlay[0]) && /"durum":"yeni"/.test(paketOlay[0]), sseMetin.slice(-600));
    ok('SSE olayinda kisisel veri YOK', paketOlay.length === 1 && !/0555|Zeynep|Dumlupinar/.test(paketOlay[0]), paketOlay[0]);
    ok('garsonun dinledigi new_order olayi URETILMEDI', !sseMetin.split('\n\n').some(f => f.includes('event: new_order') && f.includes(s1.id)));
    const kq3 = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d;
    ok('mutfakta "SofraMix SMX-AB9001" karti', kq3.kartlar.some(k => k.orderId === s1.id && k.etiket === 'SofraMix SMX-AB9001'), kq3.kartlar.map(k => k.etiket));
    const once = smxGelen.length;
    const yanlis = await aks(s1.id, 'yolda');
    ok('matriste olmayan gecis (yeni -> yolda) 409, SofraMix\'e GITMEDI', yanlis.status === 409 && smxGelen.length === once && /Onay bekliyor/.test(yanlis.d.message), yanlis);
    const ka = await aks(s1.id, 'kabul');
    ok('Onayla -> SofraMix\'e "onaylandi" yazildi (anahtar basligiyla)', ka.status === 200 && smxGelen.some(g => g.id === '9001' && g.govde.status === 'onaylandi')
        && smxSiparis.get('9001').status === 'onaylandi', ka);
    ok('yerel durum + yeni dugmeler', ka.d.siparis.harici.durum === 'onaylandi' && ka.d.siparis.aksiyonlar.map(a => a.kod).join(',') === 'hazirlaniyor,iptal', ka.d.siparis);
    ok('Hazirlaniyor', (await aks(s1.id, 'hazirlaniyor')).status === 200 && smxSiparis.get('9001').status === 'hazirlaniyor');
    ok('kasiyer SofraMix iptal edemez (403)', (await iptal(s1.id, kasiyer.token, 'Malzeme bitti, yapamiyoruz')).status === 403);
    ok('kisa iptal sebebi 400', (await iptal(s1.id, mudur.token, 'yok')).status === 400);
    const yo = await aks(s1.id, 'yolda');
    ok('Yola cikti -> SofraMix "yolda", dugmeler: Teslim edildi + Teslim edilemedi', yo.status === 200 && smxSiparis.get('9001').status === 'yolda'
        && yo.d.siparis.aksiyonlar.map(a => a.kod).join(',') === 'teslim,teslim_edilemedi' && !!yo.d.siparis.yolaCikis, yo.d && yo.d.siparis);
    const kq4 = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d;
    ok('yola cikan SofraMix siparisi mutfaktan dustu', !kq4.kartlar.some(k => k.orderId === s1.id));
    const yolIptal = await iptal(s1.id, mudur.token, 'Musteri artik istemiyor');
    ok('yoldayken iptal YOK (409, "Teslim edilemedi" yonlendirmesi), SofraMix\'e gitmedi', yolIptal.status === 409 && /Teslim edilemedi/.test(yolIptal.d.message)
        && smxSiparis.get('9001').status === 'yolda', yolIptal);
    ok('teslim edilemedi kisa sebep 400', (await aks(s1.id, 'teslim_edilemedi', kasiyer.token, 'yok')).status === 400);
    const te = await aks(s1.id, 'teslim_edilemedi', kasiyer.token, 'Adreste kimse yok, telefon kapali');
    ok('teslim edilemedi bildirildi: SofraMix\'e gitti, durum yolda kaldi, dugme kalkti', te.status === 200 && smxGelen.some(g => g.yol === 'teslim-edilemedi')
        && te.d.siparis.asama === 'YOLDA' && !!te.d.siparis.teslimSorunuAt && te.d.siparis.aksiyonlar.map(a => a.kod).join(',') === 'teslim', te.d && te.d.siparis);
    const ts = await aks(s1.id, 'teslim');
    ok('Teslim edildi -> SofraMix "teslim", sipariş KAPANDI', ts.status === 200 && ts.d.kapandi === true && smxSiparis.get('9001').status === 'teslim', ts);
    const od1 = (await query('SELECT method, amount, ref FROM payments WHERE order_id = ?', [s1.id])).rows;
    ok('teslimde otomatik odeme: NAKIT 265 (kapida nakit)', od1.length === 1 && od1[0].method === 'NAKIT' && od1[0].amount === 265, od1);
    // Cekme dongusu SofraMix'te "teslim"i de gorur: ikinci odeme YAZILMAMALI
    await bekle(async () => (await query("SELECT COUNT(*) c FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9001' AND platform_status = 'teslim'", [tid])).rows[0].c > 0, 8000);
    await uyu(800);
    const od1b = (await query('SELECT COUNT(*) AS c FROM payments WHERE order_id = ?', [s1.id])).rows[0].c;
    ok('cekme dongusunden gelen teslim ikinci odeme yazmadi (tek sefer)', od1b === 1, od1b);
    const sseSay = olaylar.join('').split('\n\n').filter(f => f.includes('event: paket_siparis') && f.includes(s1.id)).length;
    ok('ayni siparis icin cift uyari uretilmedi', sseSay === 1, sseSay);
    ok('islem gunlugunde teslim edilemedi kaydi', (await query("SELECT COUNT(*) c FROM islem_gunlugu WHERE hedef_id = ? AND islem = 'teslim_edilemedi'", [s1.id])).rows[0].c === 1);

    console.log('\n=== 11) SofraMix panelinden teslim (POS dugmesine basilmadan) ===');
    smxYeni(9002, { status: 'onaylandi', delivery_type: 'gel_al', payment_method: 'online_iyzico', payment_status: 'odendi', address: null,
        total_kurus: 21000, items_total_kurus: 21000, delivery_fee_kurus: 0,
        items: [{ id: 90021, product_id: 7, name: 'Kiymali Pide', qty: 1, unit_price_kurus: 21000, total_kurus: 21000, note: '', options: [] }] });
    const s2 = await bekle(() => smxBul(9002));
    ok('gel-al + online: dugmeler Hazirlaniyor + Iptal, odeme "Online odendi"', s2 && s2.teslimat === 'GEL_AL' && s2.odeme.etiket === 'Online ödendi'
        && s2.aksiyonlar.map(a => a.kod).join(',') === 'hazirlaniyor,iptal' && s2.dikkat === true && s2.musteri && !s2.musteri.adres, s2);
    for (const d of ['hazirlaniyor', 'hazir', 'teslim']) { const o = smxSiparis.get('9002'); o.status = d; o.updated_at = smxZaman(); await uyu(150); }
    const s2b = await bekle(async () => { const r = (await query('SELECT * FROM orders WHERE id = ?', [s2.id])).rows[0]; return r.status === 'CLOSED' ? r : null; });
    ok('cekme dongusu teslimi gordu: KAPANDI + kapanis/teslim zamani', s2b && !!s2b.closed_at && !!s2b.teslim_at && s2b.channel_status_raw === 'teslim', s2b);
    await uyu(1500);
    const od2 = (await query('SELECT method, amount FROM payments WHERE order_id = ?', [s2.id])).rows;
    ok('online odeme -> DIGER 210, tek kayit', od2.length === 1 && od2[0].method === 'DIGER' && od2[0].amount === 210, od2);

    console.log('\n=== 12) Maskelenen adres yerelde de silinir + Reddet ===');
    smxYeni(9003);
    const s3 = await bekle(() => smxBul(9003));
    ok('9003 geldi, musteri bilgisi var', s3 && s3.musteri && s3.musteri.tel === '05551234567', s3);
    const o3 = smxSiparis.get('9003');
    o3.address = { district: 'Merkez', silindi: true }; o3.customer_phone = 'silindi-77-ab12'; o3.customer_name = 'Silinen kullanıcı'; o3.customer_note = '';
    o3.updated_at = smxZaman();
    const s3b = await bekle(async () => { const s = await smxBul(9003); return s && s.musteriSilindi ? s : null; });
    ok('SofraMix KVKK imhasi -> yerelde ad/telefon/adres SILINDI', s3b && s3b.musteri === null && s3b.musteriSilindi === true, s3b);
    const r3 = (await query('SELECT musteri_ad, musteri_tel, musteri_adres, musteri_silindi_at, note FROM orders WHERE id = ?', [s3.id])).rows[0];
    ok('veritabaninda da bos + damga + siparis notu da silindi', !r3.musteri_ad && !r3.musteri_tel && !r3.musteri_adres && !!r3.musteri_silindi_at && !r3.note, r3);
    await bekle(async () => (await query("SELECT COUNT(*) c FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9003' AND state = 'pending'", [tid])).rows[0].c === 0);
    const olay3 = (await query("SELECT state, payload FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9003'", [tid])).rows;
    ok('olay kutusundaki ham SofraMix yukleri de bosaltildi (telefon/ad/adres/not KALMADI)', olay3.length >= 2
        && olay3.every(e => e.payload === KVKK.BOS_YUK && !/0555|Zeynep|Dumlupinar|Acisiz/.test(e.payload)), olay3.map(e => e.state + ' ' + e.payload.slice(0, 60)));
    const red = await iptal(s3.id, mudur.token, 'Malzeme bitti, hazirlayamiyoruz');
    ok('mudur yeni siparisi reddeder -> SofraMix "iptal" + sebep', red.status === 200 && smxSiparis.get('9003').status === 'iptal'
        && smxSiparis.get('9003').cancel_reason === 'Malzeme bitti, hazirlayamiyoruz', red);
    const r3b = (await query('SELECT status, closed_at, cancelled_by FROM orders WHERE id = ?', [s3.id])).rows[0];
    ok('yerelde IPTAL + kapanis zamani + kim', r3b.status === 'CANCELLED' && !!r3b.closed_at && !!r3b.cancelled_by, r3b);
    ok('red islem gunlugunde (SofraMix etiketiyle)', (await query("SELECT detay FROM islem_gunlugu WHERE hedef_id = ? AND islem = 'siparis_iptal'", [s3.id])).rows.some(r => /SofraMix/.test(r.detay)));

    console.log('\n=== 13) Platform reddi: mesaj Turkce ve aynen ===');
    smxYeni(9004);
    const s4 = await bekle(() => smxBul(9004));
    const o4 = smxSiparis.get('9004'); o4.gizli = true; o4.status = 'iptal';   // musteri SofraMix'te iptal etti, POS henuz gormedi
    const ret = await aks(s4.id, 'kabul');
    ok('SofraMix 400 -> 409 "Platform kabul etmedi: ..." (ham HTTP metni degil)', ret.status === 409 && /^Platform kabul etmedi: /.test(ret.d.message)
        && /iptal/.test(ret.d.message) && !/HTTP/.test(ret.d.message), ret);
    await query(`UPDATE tenants SET license_modules = '["BASE","MARKETPLACE"]' WHERE id = ?`, [tid]);
    const mpRet = await js(`/api/marketplace/orders/${s4.id}/aksiyon`, { token: kasiyer.token, body: { aksiyon: 'kabul' } });
    ok('pazaryeri ucu da ortak servisten ayni Turkce mesaji verir', mpRet.status === 409 && /^Platform kabul etmedi: /.test(mpRet.d.message), mpRet);
    const mpListe = (await js('/api/marketplace/orders', { token: kasiyer.token })).d;
    ok('pazaryeri listesinde telefon paketi YOK, SofraMix var', Array.isArray(mpListe) && !mpListe.some(o => o.channel === 'PAKET_SERVIS') && mpListe.some(o => o.channel === 'soframix'), Array.isArray(mpListe) && mpListe.map(o => o.channel));
    ok('pazaryeri listesinde de musteri ad/telefon/adres alani YOK', mpListe.length > 0 && mpListe.every(kisiselYok), mpListe[0] && Object.keys(mpListe[0]));
    // Elle acilan kanalin ADI orders.channel'a yazilir: salon / paket servis / adaptor kodlariyla cakismamali
    const kanalAc = (name) => js('/api/marketplace/channels', { token: sahip.token, body: { name } });
    const ayrik = [];
    for (const ad of ['PAKET_SERVIS', 'paket_servis', 'Paket', 'DINE_IN', 'soframix', ' SofraMix ']) ayrik.push(await kanalAc(ad));
    ok('elle kanal: salon/paket/adaptor kodu adlari ayrilmis (400, buyuk/kucuk harf ve bosluk duyarsiz)',
        ayrik.every(r => r.status === 400 && /ayrılmıştır/.test(r.d.message)), ayrik.map(r => r.status));
    const elle = await kanalAc('Yemeksepeti');
    ok('serbest ad (Yemeksepeti, elle siparis etiketi) acilir 201', elle.status === 201, elle);
    const yenidenAd = await js('/api/marketplace/channels/' + elle.d.id, { token: sahip.token, method: 'PUT', body: { name: 'Paket_Servis' } });
    ok('kanal adi sonradan ayrilmis ada cevrilemez (400)', yenidenAd.status === 400 && /ayrılmıştır/.test(yenidenAd.d.message), yenidenAd);
    await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [tid]);

    console.log('\n=== 13a) Yerelde kapali siparise gelen olay kapanisi/ciroyu/odemeyi DEGISTIRMEZ; ilk kez teslim gorulen siparise tek odeme ===');
    // 9100: kapanis zamani BOS eski kayit (veri onarimiyla kapanmis), 9101: 40 gun once kapanmis, 9102: yerelde iptal edilmis
    const eskiK = uuid(), eskiK2 = uuid(), eskiC = uuid();
    const eskiEkle = (id, ref, durum, tutar, acilis, kapanis) => query(
        `INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, external_order_no, status, subtotal, total, channel_status_raw,
                             delivery_mode, odeme_sekli, opened_at, closed_at)
         VALUES (?, ?, NULL, 'soframix', ?, ?, ?, ?, ?, 'yolda', 'RESTAURANT_COURIER', 'kapida_nakit', datetime('now', ?), ${kapanis ? "datetime('now', ?)" : 'NULL'})`,
        [id, tid, ref, 'SMX-AB' + ref, durum, tutar, tutar, acilis, ...(kapanis ? [kapanis] : [])]);
    await eskiEkle(eskiK, '9100', 'CLOSED', 100, '-20 days', null);
    await eskiEkle(eskiK2, '9101', 'CLOSED', 80, '-41 days', '-40 days');
    await eskiEkle(eskiC, '9102', 'CANCELLED', 90, '-2 days', '-2 days');
    const eskiSatir = async (id) => (await query('SELECT status, closed_at, teslim_at, total, musteri_tel FROM orders WHERE id = ?', [id])).rows[0];
    const [onceK2, onceC] = [await eskiSatir(eskiK2), await eskiSatir(eskiC)];
    for (const id of [9100, 9101, 9102]) smxYeni(id, { status: 'teslim', payment_status: 'odendi' });
    const eskiOlay = await bekle(async () => (await query(`SELECT COUNT(*) c FROM marketplace_events WHERE tenant_id = ?
        AND external_order_id IN ('9100', '9101', '9102') AND platform_status = 'teslim' AND state = 'done'`, [tid])).rows[0].c >= 3);
    ok('eski siparislerin "teslim" olaylari islendi', !!eskiOlay);
    const [sK, sK2, sC] = [await eskiSatir(eskiK), await eskiSatir(eskiK2), await eskiSatir(eskiC)];
    ok('9100 (kapanis zamani bos): KAPALI kaldi, kapanis BUGUNE CEKILMEDI, tutar 100 kaldi', sK.status === 'CLOSED' && sK.closed_at === null && !sK.teslim_at && sK.total === 100, sK);
    ok('9101 (40 gun once kapanmis): kapanis zamani + tutar degismedi', sK2.status === 'CLOSED' && sK2.closed_at === onceK2.closed_at && sK2.total === 80, [onceK2, sK2]);
    ok('9102 (yerelde iptal): IPTAL kaldi, kapanis zamani + tutar degismedi', sC.status === 'CANCELLED' && sC.closed_at === onceC.closed_at && sC.total === 90, [onceC, sC]);
    const eskiOdeme = (await query('SELECT COUNT(*) c FROM payments WHERE order_id IN (?, ?, ?)', [eskiK, eskiK2, eskiC])).rows[0].c;
    ok('hicbirine otomatik odeme YAZILMADI (ciro/gun sonu degismez)', eskiOdeme === 0, eskiOdeme);
    ok('kapanmis siparise musteri bilgisi YENIDEN YAZILMADI', !sK.musteri_tel && !sK2.musteri_tel && !sC.musteri_tel, [sK, sK2, sC]);
    // POS kapaliyken teslim edilmis siparis ILK KEZ goruluyor: kapali acilir, odeme platformun yontemiyle bir kez yazilir.
    // Telefon numarasi bilerek 13b'deki defter musterisiyle ayni ("Musteriyi unut" SofraMix kopyasini da siler).
    smxYeni(9005, { status: 'teslim', payment_method: 'kapida_kart', payment_status: 'odendi', customer_name: 'Ayşe Yılmaz', customer_phone: '05321112233',
        items_total_kurus: 5000, delivery_fee_kurus: 0, total_kurus: 5000,
        items: [{ id: 90051, product_id: 6, name: 'Ayran', qty: 2, unit_price_kurus: 2500, total_kurus: 5000, note: '', options: [] }] });
    await bekle(async () => (await query("SELECT COUNT(*) c FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9005' AND state = 'done'", [tid])).rows[0].c > 0);
    const s5 = (await query("SELECT * FROM orders WHERE tenant_id = ? AND channel = 'soframix' AND external_ref = '9005'", [tid])).rows[0];
    ok('ilk kez teslim gorulen 9005: ACIK degil KAPALI acildi + kapanis/teslim zamani', s5 && s5.status === 'CLOSED' && !!s5.closed_at && !!s5.teslim_at, s5);
    const od5 = s5 ? (await query('SELECT method, amount FROM payments WHERE order_id = ?', [s5.id])).rows : [];
    ok('ilk gorulen teslimde otomatik odeme: KREDI_KARTI 50 (kapida kart), tek kayit', od5.length === 1 && od5[0].method === 'KREDI_KARTI' && od5[0].amount === 50, od5);
    ok('kapali acilan siparis icin kasada zil/uyari uretilmedi', s5 && !olaylar.join('').includes(s5.id));

    console.log('\n=== 13b) Musteri defteri: telefonla hatirlama, tekillik, unutma, kiraci izolasyonu ===');
    const bul = (tel, tok = kasiyer.token) => js('/api/paket/musteri/bul', { token: tok, body: { tel } });
    const b1 = await bul('+90 (532) 111 2233');
    ok('farkli yazilmis numarayla bulunur: ad + son kullanilan adres basta', b1.status === 200 && b1.d.musteri && b1.d.musteri.ad === 'Ayşe Yılmaz'
        && b1.d.musteri.adresler[0] === 'Yeni Mah. 7. Sok. No:1' && b1.d.musteri.adresler[1] === 'Cumhuriyet Mah. 5. Sok. No:3' && b1.d.musteri.siparisSayisi === 1, b1.d);
    ok('kisa numarada kayit yok', (await bul('12')).d.musteri === null);
    ok('telefon adres satirinda aranmaz: GET ucu yok (404)', (await js('/api/paket/musteri/bul?tel=05321112233', { token: kasiyer.token })).status === 404);
    ok('mutfak hesabi defteri okuyamaz (403)', (await bul('05321112233', mutfak.token)).status === 403);
    const p5 = (await yeni({ musteriTel: '05321112233', musteriAd: 'Ayşe Yılmaz', musteriAdres: 'Üçüncü Adres Sok. 9', teslimat: 'ADRES' })).d;
    const p5b = (await yeni({ musteriTel: '0 532 111 22 33', musteriAdres: '  yeni mah.  7. sok. no:1 ', teslimat: 'ADRES' })).d;
    const defterSay = (await query('SELECT COUNT(*) c FROM paket_musterileri WHERE tenant_id = ? AND tel_norm = ?', [tid, '5321112233'])).rows[0].c;
    const b2 = (await bul('0532 111 22 33')).d.musteri;
    ok('tekil: ayni numara tek kayit, 3 siparis', defterSay === 1 && b2.siparisSayisi === 3, [defterSay, b2]);
    ok('ayni adres (bosluk/buyuk-kucuk farkli) cogalmaz, son kullanilan basta, ad korunur', b2.adresler.length === 3
        && b2.adresler[0] === 'yeni mah.  7. sok. no:1' && b2.adresler[1] === 'Üçüncü Adres Sok. 9' && b2.ad === 'Ayşe Yılmaz', b2);
    ok('SofraMix musterisi deftere GIRMEZ', (await bul('05551234567')).d.musteri === null);
    ok('B isletmesi A\'nin musterisini goremez', (await bul('05321112233', sahipB.token)).d.musteri === null);
    ok('B kendi musterisini gorur, A goremez', !!(await bul('05000000000', sahipB.token)).d.musteri && (await bul('05000000000')).d.musteri === null);
    ok('kasiyer musteriyi unutamaz (403)', (await js(`/api/paket/musteri/${b2.id}/unut`, { token: kasiyer.token, body: {} })).status === 403);
    ok('B, A\'nin musterisini unutamaz (404)', (await js(`/api/paket/musteri/${b2.id}/unut`, { token: sahipB.token, body: {} })).status === 404);
    const un = await js(`/api/paket/musteri/${b2.id}/unut`, { token: mudur.token, body: {} });
    ok('mudur unutur: kapali 2 sipariste (telefon P1 + ayni numaradan SofraMix 9005) silindi, 2 acik siparis teslim icin korundu',
        un.status === 200 && un.d.silinenSiparis === 2 && un.d.acikSiparis === 2, un);
    ok('defter kaydi silindi', (await bul('05321112233')).d.musteri === null);
    const u5 = (await query('SELECT musteri_ad, musteri_tel, musteri_adres, musteri_silindi_at, total FROM orders WHERE id = ?', [s5.id])).rows[0];
    const olay5 = (await query("SELECT payload FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9005'", [tid])).rows;
    ok('unut: SofraMix 9005 yerel kopyasi silindi (tutar kaldi) + olay kutusundaki ham yuku bosaltildi', !u5.musteri_ad && !u5.musteri_tel && !u5.musteri_adres
        && !!u5.musteri_silindi_at && u5.total === 50 && olay5.length >= 1 && olay5.every(e => e.payload === KVKK.BOS_YUK), [u5, olay5.map(e => e.payload.slice(0, 50))]);
    const up1 = (await query('SELECT musteri_ad, musteri_tel, musteri_adres, note, musteri_silindi_at, total FROM orders WHERE id = ?', [p1.id])).rows[0];
    ok('kapali P1: kisisel bilgi + not silindi, tutar kaldi', !up1.musteri_ad && !up1.musteri_tel && !up1.musteri_adres && !up1.note && !!up1.musteri_silindi_at && up1.total === 270, up1);
    ok('acik P5 bilgisini korudu', (await query('SELECT musteri_tel FROM orders WHERE id = ?', [p5.id])).rows[0].musteri_tel === '05321112233');
    const glU = (await query("SELECT detay, user_name FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'musteri_unut'", [tid])).rows[0];
    ok('islem gunlugunde (kim) ama telefon/ad YOK', glU && glU.user_name === 'Mudur Can' && !/532|Ayşe|Yılmaz/.test(glU.detay), glU);
    await js('/api/paket/' + p5.id, { token: kasiyer.token, method: 'PUT', body: { not: 'Kapıyı çalmayın' } });
    ok('unutulan musterinin acik siparisi duzenlenince defter GERI GELMEZ', (await bul('05321112233')).d.musteri === null);
    const kvkkSabit = require('./src/services/paketKvkk');
    ok('defter saklama tek sabit: 365 gun', kvkkSabit.DEFTER_SAKLAMA_GUN === 365);
    await query("UPDATE paket_musterileri SET son_siparis_at = datetime('now', '-366 days') WHERE tenant_id = ? AND tel_norm = ?", [tid, '5321234567']);
    const dsil = await kvkkSabit.defterTemizle();
    ok('365 gundur siparis vermeyen musteri defterden silindi', dsil >= 1 && (await bul('05321234567')).d.musteri === null, dsil);
    ok('yakin zamanli kayit (B) kaldi', !!(await bul('05000000000', sahipB.token)).d.musteri);
    for (const p of [p5, p5b]) await iptal(p.id, mudur.token);

    console.log('\n=== 13c) Teslimat ucreti (ayri kalem) ===');
    ok('gel-al siparisinde ucret 400', (await yeni({ musteriAd: 'X', teslimat: 'GEL_AL', teslimatUcreti: 15 })).status === 400);
    ok('negatif ucret 400', (await yeni({ musteriAd: 'X', musteriAdres: 'A', teslimat: 'ADRES', teslimatUcreti: -5 })).status === 400);
    const p7r = await yeni({ musteriAd: 'Fatma Kurt', musteriTel: '05449998877', musteriAdres: 'Kale Mah. 3', not: 'Kapıda arayın', teslimat: 'ADRES', teslimatUcreti: 25 });
    const p7 = p7r.d;
    ok('ucretli siparis: toplam 25, ucret ayri kalem, urun sayisi 0', p7r.status === 201 && p7.toplam === 25 && p7.teslimatUcreti === 25 && p7.urunSayisi === 0
        && p7.kalemler.length === 1 && p7.kalemler[0].ucret === true && p7.kalemler[0].ad === 'Teslimat ücreti', p7);
    ok('yalniz ucretle yola cikamaz (urun yok, 409)', (await aks(p7.id, 'yolda')).status === 409);
    await js(`/api/orders/${p7.id}/items`, { token: kasiyer.token, body: { productId: lahmacun.id, qty: 1 } });
    const g7 = (await js('/api/paket/' + p7.id, { token: kasiyer.token })).d;
    ok('urun eklenince toplam 145, ucret kalemi sonda', g7.toplam === 145 && g7.kalemler[g7.kalemler.length - 1].ucret === true && g7.urunSayisi === 1, g7);
    const kq7 = (await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token })).d.kartlar.find(k => k.orderId === p7.id);
    ok('teslimat ucreti mutfaga dusmez', kq7 && kq7.items.length === 1 && kq7.items[0].name === 'Lahmacun', kq7);
    const ucretSay = async () => (await query("SELECT COUNT(*) c, COALESCE(SUM(total), 0) s FROM order_items WHERE order_id = ? AND source = 'TESLIMAT_UCRETI'", [p7.id])).rows[0];
    const u30 = await js('/api/paket/' + p7.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 30 } });
    ok('ucret degisti: tek kalem 30, toplam 150', u30.status === 200 && u30.d.toplam === 150 && u30.d.teslimatUcreti === 30 && (await ucretSay()).c === 1, u30.d);
    const u0 = await js('/api/paket/' + p7.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 0 } });
    ok('ucret 0: kalem kalkti, toplam 120', u0.status === 200 && u0.d.toplam === 120 && (await ucretSay()).c === 0 && u0.d.teslimatUcreti === 0, u0.d);
    const u20 = await js('/api/paket/' + p7.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 20 } });
    ok('ucret yeniden 20: toplam 140', u20.status === 200 && u20.d.toplam === 140 && (await ucretSay()).c === 1, u20.d);
    ok('alan gonderilmezse ucret korunur', (await js('/api/paket/' + p7.id, { token: kasiyer.token, method: 'PUT', body: { not: 'Kapıda arayın lütfen' } })).d.teslimatUcreti === 20);
    const ucretKalem = (await js(`/api/orders/${p7.id}`, { token: kasiyer.token })).d.items.find(i => i.source === 'TESLIMAT_UCRETI');
    ok('ucret kalemi +/- ile degismez (409)', (await js(`/api/orders/${p7.id}/items/${ucretKalem.id}`, { token: kasiyer.token, method: 'PUT', body: { qty: 2 } })).status === 409);
    ok('ucret kalemi silinemez (409)', (await js(`/api/orders/${p7.id}/items/${ucretKalem.id}`, { token: kasiyer.token, method: 'DELETE' })).status === 409);
    const it7 = (await js(`/api/orders/${p7.id}`, { token: kasiyer.token })).d.items;
    const by7 = await js('/api/payments/by-items', { token: kasiyer.token, body: { orderId: p7.id, method: 'NAKIT', items: it7.map(i => ({ itemId: i.id, qty: i.qty })) } });
    ok('kalem bazli odemede ucret de tahsil edilir (140)', by7.status === 201 && by7.d.amount === 140, by7);
    const odenmisUcret = await js('/api/paket/' + p7.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 35 } });
    ok('odemesi alinmis ucret degistirilemez (409), siparis degismedi', odenmisUcret.status === 409 && (await ucretSay()).s === 20, odenmisUcret);
    await aks(p7.id, 'yolda');
    const t7 = await aks(p7.id, 'teslim');
    ok('teslim: odeme tamam -> kendiliginden kapandi', t7.status === 200 && t7.d.kapandi === true, t7.d);
    // Ucret dusurulunce toplam alinan odemenin altina inemez (yoksa hesap bir daha kapanamazdi)
    const p8 = (await yeni({ musteriAd: 'Ucret Dusen', musteriAdres: 'Bahce Sok. 1', teslimat: 'ADRES', teslimatUcreti: 20 })).d;
    await js(`/api/orders/${p8.id}/items`, { token: kasiyer.token, body: { productId: lahmacun.id, qty: 1 } });
    const od8 = await js('/api/payments', { token: kasiyer.token, body: { orderId: p8.id, method: 'NAKIT', amount: 140 } });
    ok('P8: 140 TL (120 + 20 ucret) tutar olarak tahsil edildi', od8.status === 201, od8);
    const dus8 = await js('/api/paket/' + p8.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 0 } });
    const g8 = (await js('/api/paket/' + p8.id, { token: kasiyer.token })).d;
    ok('ucret dusurulunce toplam odenenin altina inecekse 409 + acik mesaj; siparis degismedi', dus8.status === 409
        && /140 TL ödeme alınmış/.test(dus8.d.message) && /toplam 120 TL/.test(dus8.d.message) && /fazla ödemeyi silin/.test(dus8.d.message)
        && g8.toplam === 140 && g8.teslimatUcreti === 20, [dus8, g8.toplam, g8.teslimatUcreti]);
    const gelal8 = await js('/api/paket/' + p8.id, { token: kasiyer.token, method: 'PUT', body: { teslimat: 'GEL_AL' } });
    ok('gel-al\'a gecis (ucret duser) de ayni sekilde 409, teslimat degismedi', gelal8.status === 409
        && (await js('/api/paket/' + p8.id, { token: kasiyer.token })).d.teslimat === 'ADRES', gelal8);
    const odeme8 = (await query('SELECT id FROM payments WHERE order_id = ?', [p8.id])).rows[0].id;
    ok('kasiyer odeme silemez (403)', (await js('/api/payments/' + odeme8, { token: kasiyer.token, method: 'DELETE' })).status === 403);
    ok('mudur fazla odemeyi siler', (await js('/api/payments/' + odeme8, { token: mudur.token, method: 'DELETE' })).status === 200);
    const dus8b = await js('/api/paket/' + p8.id, { token: kasiyer.token, method: 'PUT', body: { teslimatUcreti: 0 } });
    ok('odeme silinince ucret dusurulur: toplam 120', dus8b.status === 200 && dus8b.d.toplam === 120 && dus8b.d.teslimatUcreti === 0, dus8b.d);
    await js('/api/payments', { token: kasiyer.token, body: { orderId: p8.id, method: 'NAKIT', amount: 120 } });
    await aks(p8.id, 'yolda');
    const t8 = await aks(p8.id, 'teslim');
    const k8 = (await query('SELECT status, total FROM orders WHERE id = ?', [p8.id])).rows[0];
    const s8 = (await query('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE order_id = ?', [p8.id])).rows[0].s;
    ok('ucreti dusurulen siparis teslimde kapandi: toplam 120 = odenen 120', t8.status === 200 && t8.d.kapandi === true && k8.status === 'CLOSED'
        && k8.total === 120 && s8 === 120, [t8.d && t8.d.kapandi, k8, s8]);

    console.log('\n=== 14) Rapor kirilimi: Salon / Paket / Pazaryeri ===');
    const mo = (await js('/api/orders', { token: kasiyer.token, body: { tableId: m1.id } })).d;
    await js(`/api/orders/${mo.id}/items`, { token: kasiyer.token, body: { productId: lahmacun.id, qty: 1 } });
    await js('/api/payments', { token: kasiyer.token, body: { orderId: mo.id, method: 'NAKIT', amount: 120 } });
    ok('masa hesabi kapandi', (await js(`/api/orders/${mo.id}/close`, { token: kasiyer.token, body: {} })).status === 200);
    const gun = (await js('/api/reports/day', { token: sahip.token })).d;
    const tt = gun.totals;
    // Paket = P1 270 + P2 60 + P9 30 + P7 140 (20 TL teslimat ucreti dahil) + P8 120 = 620
    // Pazaryeri = 9001 265 + 9002 210 + 9005 50 = 525 (yerelde kapali 9100/9101/9102'ye gelen olaylar EKLEMEDI)
    ok('Salon 120 / Paket 620 / Pazaryeri 525 (paket pazaryerine KARISMADI)', tt.dine_in_revenue === 120 && tt.paket_revenue === 620 && tt.marketplace_revenue === 525 && tt.revenue === 1265, tt);
    const kanal = Object.fromEntries(gun.byChannel.map(c => [c.label, c.revenue]));
    ok('kanal etiketleri: Salon, Paket, SofraMix', kanal.Salon === 120 && kanal.Paket === 620 && kanal.SofraMix === 525, gun.byChannel);
    const odm = Object.fromEntries(gun.byPayment.map(p => [p.method, p.amount]));
    // NAKIT = P1 270 + P9 30 + P7 140 + P8 120 + 9001 265 + masa 120; KART = P2 60 + 9005 50; DIGER = 9002 210
    ok('gun sonu odeme dagilimi tutar: NAKIT 945, KART 110, DIGER 210', odm.NAKIT === 945 && odm.KREDI_KARTI === 110 && odm.DIGER === 210, odm);
    ok('"En cok satan"da teslimat ucreti YOK', gun.topProducts.length > 0 && !gun.topProducts.some(p => p.name === 'Teslimat ücreti'), gun.topProducts.map(p => p.name));
    const ay = (await js('/api/reports/month', { token: sahip.token })).d;
    ok('aylik: paket ayri sutun', ay.totals.paket === 620 && ay.totals.marketplace === 525 && ay.totals.dine_in === 120, ay.totals);
    ok('aylik "En cok satan"da da teslimat ucreti YOK', !ay.topProducts.some(p => p.name === 'Teslimat ücreti'));

    console.log('\n=== 14b) Yerelde kapat: platforma gitmez, yalniz sahip/mudur, sonuc + sebep zorunlu, gunlukte ===');
    smxYeni(9006, { status: 'onaylandi' });
    smxYeni(9007, { status: 'yolda' });
    const s6 = await bekle(() => smxBul(9006));
    const s7 = await bekle(() => smxBul(9007));
    ok('pazaryeri siparisinde "Yerelde kapat" secenegi var', s6 && s6.yerelKapatilabilir === true && s7 && s7.yerelKapatilabilir === true, [s6, s7]);
    for (const id of ['9006', '9007']) smxSiparis.get(id).gizli = true;   // kanal koptu: platform siparisi bir daha gostermiyor
    const yk = (id, tok, body) => js(`/api/paket/${id}/yerel-kapat`, { token: tok, body });
    const gelen0 = smxGelen.length;
    ok('kasiyer yerelde kapatamaz (403)', (await yk(s6.id, kasiyer.token, { sonuc: 'IPTAL', sebep: 'Kanal baglantisi koptu' })).status === 403);
    ok('garson yerelde kapatamaz (403)', (await yk(s6.id, garson.token, { sonuc: 'IPTAL', sebep: 'Kanal baglantisi koptu' })).status === 403);
    ok('sonuc secilmeden 400', (await yk(s6.id, mudur.token, { sebep: 'Kanal baglantisi koptu' })).status === 400);
    ok('kisa sebep 400', (await yk(s6.id, mudur.token, { sonuc: 'IPTAL', sebep: 'koptu' })).status === 400);
    const p10 = (await yeni({ musteriAd: 'Yerel Deneme', teslimat: 'GEL_AL' })).d;
    ok('telefon siparisinde secenek yok ve yerelde kapatilmaz (400)', p10.yerelKapatilabilir === false
        && (await yk(p10.id, mudur.token, { sonuc: 'IPTAL', sebep: 'Kanal baglantisi koptu' })).status === 400);
    await iptal(p10.id, kasiyer.token);
    const yk6 = await yk(s6.id, mudur.token, { sonuc: 'IPTAL', sebep: 'SofraMix panelinde iptal edildi, POS gormedi' });
    const r6 = (await query('SELECT status, closed_at, cancelled_by FROM orders WHERE id = ?', [s6.id])).rows[0];
    ok('IPTAL sayildi: yerelde IPTAL + kapanis zamani + kim; ciroya girmez', yk6.status === 200 && r6.status === 'CANCELLED' && !!r6.closed_at && !!r6.cancelled_by
        && (await query('SELECT COUNT(*) c FROM payments WHERE order_id = ?', [s6.id])).rows[0].c === 0, [yk6, r6]);
    const yk7 = await yk(s7.id, sahip.token, { sonuc: 'TESLIM', sebep: 'Kurye teslim etti, SofraMix baglantisi koptu' });
    const r7 = (await query('SELECT status, closed_at, teslim_at FROM orders WHERE id = ?', [s7.id])).rows[0];
    const od7 = (await query('SELECT method, amount FROM payments WHERE order_id = ?', [s7.id])).rows;
    ok('TESLIM sayildi: KAPALI + teslim zamani + eksik odeme platformun yontemiyle (NAKIT 265)', yk7.status === 200 && r7.status === 'CLOSED' && !!r7.closed_at
        && !!r7.teslim_at && yk7.d.otoOdeme === 265 && od7.length === 1 && od7[0].method === 'NAKIT' && od7[0].amount === 265, [yk7.d && yk7.d.otoOdeme, r7, od7]);
    ok('platforma HICBIR istek gitmedi', smxGelen.length === gelen0, smxGelen.slice(gelen0));
    ok('ikinci kez yerelde kapatma 409', (await yk(s7.id, mudur.token, { sonuc: 'TESLIM', sebep: 'Kurye teslim etti, tekrar' })).status === 409);
    const glY = (await query("SELECT user_name, detay, hedef_id FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'yerel_kapat'", [tid])).rows;
    const gl6 = glY.find(g => g.hedef_id === s6.id), gl7 = glY.find(g => g.hedef_id === s7.id);
    ok('islem gunlugu: kim + etiket + sonuc + "platforma iletilmedi" + sebep', glY.length === 2 && gl6 && gl6.user_name === 'Mudur Can'
        && /SofraMix SMX-AB9006/.test(gl6.detay) && /iptal sayıldı/.test(gl6.detay) && /platforma iletilmedi/.test(gl6.detay) && /POS gormedi/.test(gl6.detay)
        && gl7 && /teslim edildi sayıldı/.test(gl7.detay) && /265 TL/.test(gl7.detay), glY);
    // Platform sonradan "teslim" gosterse de yerel IPTAL kararini degistirmez (ciroya/odemeye girmez)
    const o6 = smxSiparis.get('9006'); o6.gizli = false; o6.status = 'teslim'; o6.updated_at = smxZaman();
    const olay6 = await bekle(async () => (await query(`SELECT COUNT(*) c FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9006'
        AND platform_status = 'teslim' AND state = 'done'`, [tid])).rows[0].c > 0);
    const r6b = (await query('SELECT status, closed_at FROM orders WHERE id = ?', [s6.id])).rows[0];
    ok('sonradan gelen platform "teslim"i yerel IPTAL kapanisini DEGISTIRMEDI, odeme yazilmadi', !!olay6 && r6b.status === 'CANCELLED' && r6b.closed_at === r6.closed_at
        && (await query('SELECT COUNT(*) c FROM payments WHERE order_id = ?', [s6.id])).rows[0].c === 0, r6b);
    // Eski surum "teslim edilemedi"yi ham durum olarak yaziyordu (teslim_sorunu_at bos): bildirilmis sayilir
    const eskiTE = uuid();
    await query(`INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, external_order_no, status, subtotal, total, channel_status_raw,
                                     delivery_mode, odeme_sekli, opened_at)
                 VALUES (?, ?, NULL, 'soframix', 'ESKI-TE', 'SMX-ESKITE', 'OPEN', 75, 75, 'teslim_edilemedi', 'RESTAURANT_COURIER', 'kapida_nakit',
                         datetime('now', '-1 hours'))`, [eskiTE, tid]);
    const gTE = (await js('/api/paket/' + eskiTE, { token: kasiyer.token })).d;
    ok('eski "teslim_edilemedi" ham durumu: Yolda, tekrar bildirim dugmesi YOK (yalniz Teslim edildi), uyari var, yerelde kapatilabilir',
        gTE.asama === 'YOLDA' && gTE.aksiyonlar.map(a => a.kod).join(',') === 'teslim' && gTE.teslimSorunu === true && !gTE.teslimSorunuAt
        && gTE.yerelKapatilabilir === true, gTE);
    const ykTE = await yk(eskiTE, mudur.token, { sonuc: 'IPTAL', sebep: 'Eski kayit, SofraMix karar verdi: iptal' });
    ok('eski takili kayit yerelde kapatildi (aktif listeden cikti)', ykTE.status === 200
        && !(await js('/api/paket', { token: kasiyer.token })).d.siparisler.some(s => s.id === eskiTE && s.durum === 'OPEN'), ykTE);

    console.log('\n=== 15) Salt-okunur lisans ===');
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 86400000).toISOString(), tid]);
    const so = await js('/api/paket', { token: kasiyer.token, body: { musteriAd: 'X', teslimat: 'GEL_AL' } });
    ok('salt-okunurda yeni paket 403 LICENSE_READONLY', so.status === 403 && so.d.code === 'LICENSE_READONLY', so);
    ok('salt-okunurda liste okunur', (await js('/api/paket', { token: kasiyer.token })).status === 200);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() + 7 * 86400000).toISOString(), tid]);

    console.log('\n=== 16) KVKK: 30 gun sonra musteri bilgisi silinir ===');
    const kvkk = require('./src/services/paketKvkk');
    ok('saklama suresi tek sabit: 30 gun', kvkk.SAKLAMA_GUN === 30);
    await query("UPDATE orders SET closed_at = datetime('now', '-31 days') WHERE id IN (?, ?, ?)", [p7.id, p3.id, s1.id]);
    await query("UPDATE orders SET closed_at = datetime('now', '-29 days') WHERE id = ?", [p2.id]);
    const sil = await kvkk.temizle();
    ok('temizlik calisti', sil >= 3, sil);
    const kp = (await query('SELECT * FROM orders WHERE id = ?', [p7.id])).rows[0];
    ok('P7 (31 gun): ad/telefon/adres/not silindi, damga var', !kp.musteri_ad && !kp.musteri_tel && !kp.musteri_adres && !kp.note && !!kp.musteri_silindi_at, kp);
    ok('P7 siparis + tutar + odeme + ucret kalemi KALDI', kp.status === 'CLOSED' && kp.total === 140
        && (await query('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id = ?', [p7.id])).rows[0].s === 140 && (await ucretSay()).s === 20);
    ok('iptal edilen P3 de temizlendi', !!(await query('SELECT musteri_silindi_at s, musteri_tel t FROM orders WHERE id = ?', [p3.id])).rows.find(r => r.s && !r.t));
    const kp2 = (await query('SELECT musteri_ad, musteri_silindi_at FROM orders WHERE id = ?', [p2.id])).rows[0];
    ok('P2 (29 gun) dokunulmadi', kp2.musteri_ad === 'Mehmet' && !kp2.musteri_silindi_at, kp2);
    ok('siparisteki 30 gun silmesi musteri defterine DOKUNMAZ', !!(await bul('05449998877')).d.musteri);
    const gp7 = (await js('/api/paket/' + p7.id, { token: kasiyer.token })).d;
    ok('silinen sipariste ekran cokmez: musteri yok, "silindi" isareti', gp7.musteri === null && gp7.musteriSilindi === true, gp7);
    const damga1 = kp.musteri_silindi_at;
    await kvkk.temizle();
    ok('ikinci tur ayni siparise dokunmaz', (await query('SELECT musteri_silindi_at s FROM orders WHERE id = ?', [p7.id])).rows[0].s === damga1);
    // Silinmis SofraMix siparisi SofraMix'te tekrar degisirse (tam bilgiyle) yerelde bilgi GERI YAZILMAZ
    const evOnce = (await query("SELECT COUNT(*) c FROM marketplace_events WHERE external_order_id = '9001' AND state = 'done'")).rows[0].c;
    smxSiparis.get('9001').updated_at = smxZaman();
    await bekle(async () => (await query("SELECT COUNT(*) c FROM marketplace_events WHERE external_order_id = '9001' AND state = 'done'")).rows[0].c > evOnce, 8000);
    const ks1 = (await query('SELECT musteri_ad, musteri_tel, musteri_adres FROM orders WHERE id = ?', [s1.id])).rows[0];
    ok('KVKK silinen SofraMix siparisine bilgi geri yazilmadi', !ks1.musteri_ad && !ks1.musteri_tel && !ks1.musteri_adres, ks1);
    const olay1 = (await query("SELECT payload FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9001'", [tid])).rows;
    ok('olay kutusu: 30 gun silmesi 9001\'in olay yuklerini bosaltti; silmeden SONRA gelen olayin ham yuku de saklanmadi',
        olay1.length >= 2 && olay1.every(e => e.payload === kvkk.BOS_YUK), olay1.map(e => e.payload.slice(0, 40)));
    const olay9101 = (await query("SELECT payload FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9101'", [tid])).rows;
    ok('40 gun once kapanmis 9101: siparis silmesiyle olay yuku de bosaltildi', olay9101.length >= 1 && olay9101.every(e => e.payload === kvkk.BOS_YUK)
        && !!(await query("SELECT musteri_silindi_at s FROM orders WHERE id = ?", [eskiK2])).rows[0].s, olay9101.map(e => e.payload.slice(0, 40)));
    // Siparisi olmayan / acik olmayan 30 gunden eski islenmis olay bosaltilir; islenmemis (pending) olay ve ACIK siparisin (9004)
    // olayi teslim icin korunur
    const olayEkle = async (ref, durum) => {
        const id = uuid();
        await query(`INSERT INTO marketplace_events (id, tenant_id, channel_id, channel_code, source, event_key, external_order_id, platform_status,
                                                     payload, state, received_at)
                     VALUES (?, ?, ?, 'soframix', 'poll', ?, ?, 'teslim', ?, ?, datetime('now', '-31 days'))`,
            [id, tid, kanalId, 'eski-olay-' + id, ref, JSON.stringify({ id: ref, customer_phone: '05559998877', customer_name: 'Eski Musteri' }), durum]);
        return id;
    };
    const yetimOlay = await olayEkle('YETIM-1', 'done'), hataliOlay = await olayEkle('YETIM-2', 'failed'), bekleyenOlay = await olayEkle('YETIM-3', 'pending');
    await query("UPDATE marketplace_events SET received_at = datetime('now', '-31 days') WHERE tenant_id = ? AND external_order_id = '9004'", [tid]);
    await kvkk.temizle();
    const yuk = async (id) => (await query('SELECT payload FROM marketplace_events WHERE id = ?', [id])).rows[0].payload;
    ok('31 gunluk islenmis (done/failed) olay, siparisi acik degilse bosaltildi', await yuk(yetimOlay) === kvkk.BOS_YUK && await yuk(hataliOlay) === kvkk.BOS_YUK);
    ok('islenmemis (pending) olayin yukune dokunulmadi', /05559998877/.test(await yuk(bekleyenOlay)));
    const olay4 = (await query("SELECT payload FROM marketplace_events WHERE tenant_id = ? AND external_order_id = '9004'", [tid])).rows;
    ok('ACIK siparisin (9004) eski olay yuku teslim icin korundu', olay4.length >= 1 && olay4.every(e => /05551234567/.test(e.payload)), olay4.length);
    await query('DELETE FROM marketplace_events WHERE id = ?', [bekleyenOlay]);

    console.log('\n=== 16b) Eski hatali kayit onarimi: teslim/iptal olmus ama ACIK kalmis SofraMix siparisi ===');
    // Eski cekme kodu ilk gorusunde teslim olmus siparisi ACIK yaziyordu; Paket Servis'te sonsuza dek aktif gorunurdu
    const eskiT = uuid(), eskiI = uuid();
    await query(`INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, status, total, channel_status_raw, opened_at)
                 VALUES (?, ?, NULL, 'soframix', 'ESKI-T', 'OPEN', 100, 'teslim', datetime('now', '-3 days'))`, [eskiT, tid]);
    await query(`INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, status, total, channel_status_raw, opened_at)
                 VALUES (?, ?, NULL, 'soframix', 'ESKI-I', 'OPEN', 80, 'iptal', datetime('now', '-3 days'))`, [eskiI, tid]);
    initDb(); await uyu(900);
    const onT = (await query('SELECT status, closed_at FROM orders WHERE id = ?', [eskiT])).rows[0];
    const onI = (await query('SELECT status FROM orders WHERE id = ?', [eskiI])).rows[0];
    ok('teslim olmus -> KAPALI, iptal olmus -> IPTAL; kapanis zamani (gecmis raporlar) DEGISMEDI', onT.status === 'CLOSED' && !onT.closed_at && onI.status === 'CANCELLED', [onT, onI]);
    ok('Paket Servis aktif listesinde yoklar', !(await js('/api/paket', { token: kasiyer.token })).d.siparisler.some(s => [eskiT, eskiI].includes(s.id)));

    console.log('\n=== 16c) Pazaryeri bagimsizligi: esleme tablosunda satiri olmayan kanal listeye DUSMEZ, satir eklemek yeter ===');
    const P = require('./src/services/paketServis');
    const ES = require('./src/marketplace/paketEsleme');
    const sbxId = uuid();
    await query(`INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, external_order_no, status, total, channel_status_raw, delivery_mode)
                 VALUES (?, ?, NULL, 'sandbox', 'SBX-77', 'SB77', 'OPEN', 50, 'Created', 'RESTAURANT_COURIER')`, [sbxId, tid]);
    ok('satiri olmayan adaptorun (sandbox) siparisi Paket Servis\'te YOK', !(await js('/api/paket', { token: kasiyer.token })).d.siparisler.some(s => s.id === sbxId)
        && (await js('/api/paket/' + sbxId, { token: kasiyer.token })).status === 404);
    const sbxSatir = (await query('SELECT * FROM orders WHERE id = ?', [sbxId])).rows[0];
    ok('satirsiz kanalda asama/dugme uretilmez', P.aksiyonlarOf(sbxSatir).length === 0 && !P.dikkatMi(sbxSatir));
    // Yeni pazaryeri = TEK satir (Trendyol GO sozluguyle ornek; sandbox adaptoru ayni sozlugu kullaniyor)
    const TGO = require('./src/marketplace/adapters/trendyolgo/mapping');
    ES.ESLEME.sandbox = { ad: 'Deneme Pazaryeri', durumNormal: TGO.STATUS_TO_NORMALIZED,
        gecisler: { Created: ['Picking', 'UnSupplied'], Picking: ['Invoiced', 'UnSupplied'], Invoiced: ['Shipped'], Shipped: ['Delivered'] },
        yalnizAdrese: ['DISPATCHED'], reddetDurum: ['NEW'], dikkat: ['NEW'], odeme: { PAY_WITH_CARD: { pos: 'DIGER', etiket: 'Online ödendi' } }, musteri: true };
    try {
        ok('satir eklenince liste kosulu kanali kapsar', P.paketKosulu().includes("'sandbox'"));
        const g = P.gorunum(sbxSatir, [], 0);
        ok('asama/rozet/etiket satirdan: Onay bekliyor, "Deneme Pazaryeri"', g.asama === 'YENI' && g.kaynak === 'PAZARYERI' && g.kaynakAd === 'Deneme Pazaryeri'
            && g.etiket === 'Deneme Pazaryeri SB77' && g.dikkat === true, g);
        // Gecis matrisi + adaptor yetenegi: sandbox acceptReject var, markPreparing YOK
        ok('dugmeler gecis matrisinden: Onayla + Reddet', g.aksiyonlar.map(a => a.kod + ':' + a.etiket).join(',') === 'kabul:Onayla,iptal:Reddet', g.aksiyonlar);
        const ilerle = (ham) => P.aksiyonlarOf({ ...sbxSatir, channel_status_raw: ham }).map(a => a.kod).join(',');
        ok('Picking -> Hazir (+iptal), Invoiced -> Yola cikti, Shipped -> Teslim edildi', ilerle('Picking') === 'hazir,iptal' && ilerle('Invoiced') === 'yolda'
            && ilerle('Shipped') === 'teslim', [ilerle('Picking'), ilerle('Invoiced'), ilerle('Shipped')]);
        ok('islem sonrasi yerel ham durum platformun sozlugunden (kabul -> Picking)', P.hedefHam(sbxSatir, 'kabul') === 'Picking');
        ok('eski olay durumu geri almaz (Shipped -> Created yok)', P.geriMi('sandbox', 'Shipped', 'Created') === true && P.geriMi('sandbox', 'Created', 'Picking') === false);
        ok('odeme yontemi satirdan', P.posYontemi('sandbox', 'PAY_WITH_CARD') === 'DIGER' && P.odemeBilgisi('sandbox', 'PAY_WITH_CARD').etiket === 'Online ödendi');
    } finally { delete ES.ESLEME.sandbox; }
    ok('satir kaldirilinca kanal yine kapsam disi', !P.paketKosulu().includes("'sandbox'"));
    await query('DELETE FROM orders WHERE id = ?', [sbxId]);

    console.log('\n=== 16d) Liste siniri yalniz bitenlere: ACIK siparis 300 sinirinda KESILMEZ (B isletmesi) ===');
    const unutulanAcik = uuid();
    await query(`INSERT INTO orders (id, tenant_id, table_id, channel, status, subtotal, total, paket_durum, musteri_ad, delivery_mode, opened_at)
                 VALUES (?, ?, NULL, 'PAKET_SERVIS', 'OPEN', 0, 0, 'HAZIRLANIYOR', 'Unutulan Siparis', 'PICKUP', datetime('now', '-2 days'))`, [unutulanAcik, tidB]);
    for (let i = 0; i < 301; i++) {
        await query(`INSERT INTO orders (id, tenant_id, table_id, channel, status, subtotal, total, paket_durum, delivery_mode, opened_at, closed_at)
                     VALUES (?, ?, NULL, 'PAKET_SERVIS', 'CLOSED', 10, 10, 'TESLIM', 'PICKUP', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [uuid(), tidB]);
    }
    const lbB = (await js('/api/paket', { token: sahipB.token })).d;
    const bitenB = lbB.siparisler.filter(s => s.durum !== 'OPEN').length;
    ok('bugun 301 siparis kapansa da 2 gun onceki ACIK siparis + bugunku acik siparis listede; bitenler 300 ile sinirli',
        lbB.siparisler.some(s => s.id === unutulanAcik) && lbB.siparisler.some(s => s.id === pB.id) && bitenB === 300 && lbB.sayac.aktif === 2,
        [bitenB, lbB.sayac, lbB.siparisler.filter(s => s.durum === 'OPEN').map(s => s.etiket)]);

    console.log('\n=== 17) Anahtar gecersiz: yetki sorunu anlasilir ===');
    smxAnahtarIptal = true;
    const yet = await aks(s4.id, 'kabul');
    ok('401 -> 409 + yetkiSorunu + "yeniden bagla" mesaji', yet.status === 409 && yet.d.yetkiSorunu === true && /yeniden bağlayın/.test(yet.d.message), yet);

    abc.abort();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
