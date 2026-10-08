// SofraMix OTOMATIK kanal baglantisi: devir sonrasi POS, sahte SofraMix'ten sunucudan sunucuya
// anahtar alir, kanali baglar, menuyu ceker. Sahte SofraMix bu testin icinde kosar.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45964, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const SMX_PORT = 45965, SMX = `http://127.0.0.1:${SMX_PORT}`;
const GIZLI = 'test-gizli-anahtar-1234567890', PLATFORM = 'platform-test-anahtari-xyz';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 778001, isletme_slug: 'oto-test', isletme_adi: 'Oto Baglanti Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: 'Kurtulus Cad. No: 12', fatura_adres: 'Fatura Mah. 5. Sok. No: 3 Merkez/Afyonkarahisar', unvan: 'Oto Gida Ltd.', vergi_dairesi: 'Kocatepe', vergi_no: '9876543210',
        yetkili_ad: 'Oto Sahibi', yetkili_email: 'oto-sahibi@ornek.test', yetkili_tel: '05329876543',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'), ...x,
    };
}
const kanonik = (g) => JSON.stringify(g, Object.keys(g).sort());
const imzala = (g) => crypto.createHmac('sha256', GIZLI).update(kanonik(g)).digest('hex');
function baglanti(g) {
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', '1');
    u.searchParams.set('yuk', Buffer.from(kanonik(g), 'utf8').toString('base64url'));
    u.searchParams.set('imza', imzala(g));
    return u.toString();
}
async function git(url) {
    const r = await fetch(url, { redirect: 'manual' });
    return { status: r.status, yer: r.headers.get('location') || '', govde: await r.text().catch(() => '') };
}
async function temizle() {
    const t = await query("SELECT id FROM tenants WHERE business_name IN ('Oto Baglanti Lokanta', 'Oto Red Lokanta', 'Oto Bozuk Lokanta', 'Oto Yaris Lokanta')");
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'marketplace_product_map',
            'marketplace_store_links', 'marketplace_credentials', 'marketplace_channels', 'products', 'categories']) {
            await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id IN ('778001','778002','778003','778004')");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no IN ('778001','778002','778003','778004')");
}

// ——— Sahte SofraMix ———
const sayac = { anahtarIstek: 0, menuIstek: 0 };
const verilen = new Set();          // uretilen anahtarlar
const bozukAnahtar = new Set();     // uretildi ama menu ucunda 401 verecek (778003)
const iptal = new Set();            // isletme SofraMix panelinden iptal etti -> 401
function govdeOku(req) { return new Promise((r) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (_) { r({}); } }); }); }
const smx = http.createServer(async (req, res) => {
    const u = new URL(req.url, SMX);
    const json = (kod, g) => { res.writeHead(kod, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(g)); };
    if (u.pathname === '/api/platform/pos-odemeleri') return json(200, { odemeler: [] });
    if (u.pathname === '/api/platform/pos-makine-anahtari' && req.method === 'POST') {
        if (req.headers['x-smx-platform-anahtar'] !== PLATFORM) return json(401, { error: 'platform anahtari' });
        const b = await govdeOku(req);
        sayac.anahtarIstek++;
        if (b.isletme_no === 778002) return json(403, { error: 'Bu isletme icin izin yok' });
        const anahtar = 'smx_' + crypto.randomBytes(16).toString('hex');
        verilen.add(anahtar);
        if (b.isletme_no === 778003) bozukAnahtar.add(anahtar);
        return json(201, { id: sayac.anahtarIstek, anahtar, izinler: ['menu_oku', 'siparis_oku', 'siparis_yaz', 'dukkan_yonet'] });
    }
    if (u.pathname === '/api/business/menu') {
        sayac.menuIstek++;
        const k = req.headers['x-smx-anahtar'];
        if (!verilen.has(k) || bozukAnahtar.has(k) || iptal.has(k)) return json(401, { error: 'anahtar gecersiz' });
        return json(200, {
            categories: [{ id: 1, name: 'Çorbalar', sort: 1 }, { id: 2, name: 'Ana Yemek', sort: 2 }],
            products: [
                { id: 11, name: 'Mercimek Çorbası', category_id: 1, price_kurus: 9000, sort: 1, image_url: '/uploads/mercimek.jpg', alerjen: null },
                { id: 12, name: 'Ezogelin', category_id: 1, price_kurus: 9500, sort: 2, image_url: null, alerjen: null },
                { id: 21, name: 'Kuru Fasulye', category_id: 2, price_kurus: 18000, sort: 1, image_url: null, alerjen: null },
            ],
        });
    }
    if (u.pathname === '/api/business/orders') return json(200, { orders: [] });
    json(404, { error: 'yok' });
});

(async () => {
    initDb(); await uyu(900); await temizle();
    await new Promise((r) => smx.listen(SMX_PORT, '127.0.0.1', r));
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               SOFRAMIX_PLATFORM_URL: SMX, SOFRAMIX_PLATFORM_ANAHTAR: PLATFORM,
               JWT_SECRET: 'oto-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} try { smx.close(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== 1) Devir -> kiraci + SofraMix kanali OTOMATIK bagli + menu cekildi ===');
    const r1 = await git(baglanti(govde()));
    ok('302 panele', r1.status === 302, r1.status);
    await uyu(800);
    const k1 = (await query("SELECT * FROM tenants WHERE business_name = 'Oto Baglanti Lokanta'")).rows[0];
    ok('kiraci acildi', !!k1);
    ok('fatura adresi = SofraMix fatura_adres', k1 && k1.billing_address === 'Fatura Mah. 5. Sok. No: 3 Merkez/Afyonkarahisar', k1 && k1.billing_address);
    ok('isletme adresi = acik adres + ilce/il', k1 && k1.address === 'Kurtulus Cad. No: 12, Merkez / Afyonkarahisar', k1 && k1.address);
    const kanal = (await query("SELECT * FROM marketplace_channels WHERE tenant_id = ? AND adapter_code = 'soframix'", [k1.id])).rows;
    ok('TEK SofraMix kanali, API acik', kanal.length === 1 && kanal[0].is_api_enabled === 1, kanal.map(c => c.is_api_enabled));
    const bag = (await query('SELECT l.*, c.status FROM marketplace_store_links l JOIN marketplace_credentials c ON c.id = l.credential_id WHERE l.tenant_id = ?', [k1.id])).rows;
    ok('magaza bagi isletme_no ile, kimlik aktif', bag.length === 1 && bag[0].external_store_id === '778001' && bag[0].status === 'active', bag);
    ok('SofraMix anahtar ucu 1 kez cagrildi', sayac.anahtarIstek === 1, sayac.anahtarIstek);
    const urun = (await query('SELECT name, price, is_available FROM products WHERE tenant_id = ?', [k1.id])).rows;
    ok('3 urun geldi', urun.length === 3, urun.length);
    ok('urunler 0 TL ve PASIF (Patron karari)', urun.every(u => Number(u.price) === 0 && u.is_available === 0), urun);
    ok('2 kategori geldi', (await query('SELECT COUNT(*) c FROM categories WHERE tenant_id = ?', [k1.id])).rows[0].c === 2);
    const gorsel = (await query("SELECT image_url FROM products WHERE tenant_id = ? AND name = 'Mercimek Çorbası'", [k1.id])).rows[0];
    ok('goreli SofraMix gorseli MUTLAK saklandi', gorsel && gorsel.image_url === SMX + '/uploads/mercimek.jpg', gorsel);
    // Onarim: eski aktarimdan kalma goreli adres duzelir, POS'un KENDI yuklemesi degismez
    await query("UPDATE products SET image_url = '/uploads/mercimek.jpg' WHERE tenant_id = ? AND name = 'Mercimek Çorbası'", [k1.id]);
    const kendiId = crypto.randomUUID();
    await query("INSERT INTO products (id, tenant_id, name, price, image_url) VALUES (?, ?, 'POS Kendi Urunu', 10, '/uploads/kendi.jpg')", [kendiId, k1.id]);
    const onarildi = await require('./src/services/menuAktarim').gorselAdresleriniOnar(SMX);
    ok('onarim 1 satir duzeltti', onarildi === 1, onarildi);
    ok('SofraMix gorseli mutlak oldu', (await query("SELECT image_url u FROM products WHERE tenant_id = ? AND name = 'Mercimek Çorbası'", [k1.id])).rows[0].u === SMX + '/uploads/mercimek.jpg');
    ok("POS'un kendi gorseli DEGISMEDI", (await query('SELECT image_url u FROM products WHERE id = ?', [kendiId])).rows[0].u === '/uploads/kendi.jpg');
    await query('DELETE FROM products WHERE id = ?', [kendiId]);
    const sifreli = (await query('SELECT cipher_blob, fingerprint FROM marketplace_credentials WHERE tenant_id = ?', [k1.id])).rows[0];
    ok('anahtar DUZ metin olarak DB de yok (sifreli blob)', sifreli && !String(sifreli.cipher_blob).includes('smx_') && !String(sifreli.fingerprint || '').includes([...verilen][0]), sifreli && sifreli.fingerprint);

    console.log('\n=== 2) Ikinci devir (ayni isletme): yeniden anahtar ISTENMEZ, menu yeniden CEKILMEZ ===');
    const menuOnce = sayac.menuIstek;
    const r2 = await git(baglanti(govde({ nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302', r2.status === 302, r2.status);
    await uyu(600);
    ok('anahtar ucu hala 1 kez', sayac.anahtarIstek === 1, sayac.anahtarIstek);
    ok('menu ucuna gidilmedi', sayac.menuIstek === menuOnce, [menuOnce, sayac.menuIstek]);
    ok('hala tek kanal', (await query("SELECT COUNT(*) c FROM marketplace_channels WHERE tenant_id = ?", [k1.id])).rows[0].c === 1);
    ok('hala 3 urun', (await query('SELECT COUNT(*) c FROM products WHERE tenant_id = ?', [k1.id])).rows[0].c === 3);

    console.log('\n=== 3) SofraMix 403 (izin yok): devir yine tamamlanir, kanal bagli DEGIL ===');
    const r3 = await git(baglanti(govde({ isletme_no: 778002, isletme_adi: 'Oto Red Lokanta', yetkili_email: 'oto-red@ornek.test', nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302 (devir durmadi)', r3.status === 302, r3.status);
    await uyu(600);
    const k3 = (await query("SELECT id FROM tenants WHERE business_name = 'Oto Red Lokanta'")).rows[0];
    ok('kiraci acildi', !!k3);
    ok('kimlik/bag yok', (await query('SELECT COUNT(*) c FROM marketplace_store_links WHERE tenant_id = ?', [k3.id])).rows[0].c === 0);
    ok('menu bos', (await query('SELECT COUNT(*) c FROM products WHERE tenant_id = ?', [k3.id])).rows[0].c === 0);

    console.log('\n=== 4) Anahtar verildi ama dogrulama 401: KAYDEDILMEZ ===');
    const r4 = await git(baglanti(govde({ isletme_no: 778003, isletme_adi: 'Oto Bozuk Lokanta', yetkili_email: 'oto-bozuk@ornek.test', nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302', r4.status === 302, r4.status);
    await uyu(600);
    const k4 = (await query("SELECT id FROM tenants WHERE business_name = 'Oto Bozuk Lokanta'")).rows[0];
    ok('calismayan anahtar saklanmadi', (await query('SELECT COUNT(*) c FROM marketplace_credentials WHERE tenant_id = ?', [k4.id])).rows[0].c === 0);
    ok('kanal API kapali', (await query("SELECT COALESCE(MAX(is_api_enabled),0) m FROM marketplace_channels WHERE tenant_id = ?", [k4.id])).rows[0].m === 0);

    console.log('\n=== 5) "Menuyu cek" dugmesi (HTTP) hala calisiyor: onizleme, yeni 0 ===');
    const jeton = r1.yer.split('/deneme-giris/')[1];
    const t1 = await (await fetch(TABAN + '/api/public/deneme-giris/' + jeton, { method: 'POST' })).json();
    const on = await fetch(TABAN + '/api/marketplace/channels/' + kanal[0].id + '/menu/pull', { method: 'POST', headers: { Authorization: 'Bearer ' + t1.token } });
    const onG = await on.json();
    ok('200 onizleme', on.status === 200 && onG.onizleme === true, [on.status, onG]);
    ok('toplam 3, yeni 0 (mukerrer yok)', onG.urun && onG.urun.toplam === 3 && onG.urun.yeni === 0, onG.urun);

    console.log('\n=== 6) Isletme anahtari IPTAL etti (401): kimlik gecersiz, yeniden ISTENMEZ; yeni devirde yenilenir ===');
    for (const a of verilen) if (!bozukAnahtar.has(a)) iptal.add(a);
    const istekOnce = sayac.anahtarIstek;
    const cek = await fetch(TABAN + '/api/marketplace/channels/' + kanal[0].id + '/menu/pull', { method: 'POST', headers: { Authorization: 'Bearer ' + t1.token } });
    const cekG = await cek.json();
    ok('menu cekme 502 + kimlikGecersiz', cek.status === 502 && cekG.kimlikGecersiz === true, [cek.status, cekG]);
    ok('kimlik invalid isaretlendi', (await query("SELECT status FROM marketplace_credentials WHERE tenant_id = ?", [k1.id])).rows[0].status === 'invalid');
    ok('kendiliginden yeni anahtar ISTENMEDI', sayac.anahtarIstek === istekOnce, sayac.anahtarIstek);
    const liste = await (await fetch(TABAN + '/api/marketplace/channels', { headers: { Authorization: 'Bearer ' + t1.token } })).json();
    ok('kanal listesi kimlik_durum=invalid donuyor (arayuz "baglanti koptu")', liste[0] && liste[0].kimlik_durum === 'invalid', liste[0]);
    const r6 = await git(baglanti(govde({ nonce: crypto.randomBytes(12).toString('hex') })));
    ok('yeni devir 302', r6.status === 302, r6.status);
    await uyu(800);
    ok('devirde yeniden anahtar alindi', sayac.anahtarIstek === istekOnce + 1, sayac.anahtarIstek);
    ok('kimlik yeniden aktif', (await query("SELECT status FROM marketplace_credentials WHERE tenant_id = ?", [k1.id])).rows[0].status === 'active');
    ok('hala tek kimlik kaydi, tek bag', (await query("SELECT (SELECT COUNT(*) FROM marketplace_credentials WHERE tenant_id = ?) + (SELECT COUNT(*) FROM marketplace_store_links WHERE tenant_id = ?) AS n", [k1.id, k1.id])).rows[0].n === 2);
    ok('urunler mukerrer degil (3)', (await query('SELECT COUNT(*) c FROM products WHERE tenant_id = ?', [k1.id])).rows[0].c === 3);

    console.log('\n=== 7) ES ZAMANLI iki devir (cift tiklama): tek kanal, tek anahtar istegi, 3 urun ===');
    const istek7 = sayac.anahtarIstek;
    const y = () => govde({ isletme_no: 778004, isletme_adi: 'Oto Yaris Lokanta', yetkili_email: 'oto-yaris@ornek.test', nonce: crypto.randomBytes(12).toString('hex') });
    const [ya, yb] = await Promise.all([git(baglanti(y())), git(baglanti(y()))]);
    ok('ikisi de 302', ya.status === 302 && yb.status === 302, [ya.status, yb.status]);
    await uyu(1000);
    const k7 = (await query("SELECT id FROM tenants WHERE business_name = 'Oto Yaris Lokanta'")).rows;
    ok('TEK kiraci', k7.length === 1, k7.length);
    ok('anahtar ucu 1 kez', sayac.anahtarIstek === istek7 + 1, sayac.anahtarIstek - istek7);
    ok('tek kanal, tek bag', (await query("SELECT (SELECT COUNT(*) FROM marketplace_channels WHERE tenant_id = ?) * 10 + (SELECT COUNT(*) FROM marketplace_store_links WHERE tenant_id = ?) AS n", [k7[0].id, k7[0].id])).rows[0].n === 11);
    ok('3 urun, 2 kategori (mukerrer yok)', (await query('SELECT (SELECT COUNT(*) FROM products WHERE tenant_id = ?) * 10 + (SELECT COUNT(*) FROM categories WHERE tenant_id = ?) AS n', [k7[0].id, k7[0].id])).rows[0].n === 32);

    console.log('\n=== 8) Mevcut kiracida BOS fatura alanlari ikinci devirde dolar, dolu olan EZILMEZ ===');
    await query("UPDATE tenants SET billing_address = NULL, address = NULL, billing_tax_office = 'Elle Girilen VD' WHERE id = ?", [k1.id]);
    const r8 = await git(baglanti(govde({ nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302', r8.status === 302, r8.status);
    const k8 = (await query('SELECT billing_address, address, billing_tax_office FROM tenants WHERE id = ?', [k1.id])).rows[0];
    ok('bos fatura adresi dolduruldu', k8.billing_address === 'Fatura Mah. 5. Sok. No: 3 Merkez/Afyonkarahisar' && k8.address === 'Kurtulus Cad. No: 12, Merkez / Afyonkarahisar', k8);
    ok('elle girilen vergi dairesi KORUNDU', k8.billing_tax_office === 'Elle Girilen VD', k8);

    console.log('\n=== 9) Yarim kayit onarimi: is_api_enabled=0 kalmissa sonraki devir 1 yapar ===');
    await query('UPDATE marketplace_channels SET is_api_enabled = 0 WHERE id = ?', [kanal[0].id]);
    await git(baglanti(govde({ nonce: crypto.randomBytes(12).toString('hex') })));
    await uyu(600);
    ok('is_api_enabled yeniden 1 (menu dugmesi gorunur)', (await query('SELECT is_api_enabled FROM marketplace_channels WHERE id = ?', [kanal[0].id])).rows[0].is_api_enabled === 1);

    console.log('\n=== 10) ES ZAMANLI iki "Aktar" (cift tiklama): urun ikilenmez ===');
    await query('DELETE FROM marketplace_product_map WHERE tenant_id = ?', [k1.id]);
    await query('DELETE FROM products WHERE tenant_id = ?', [k1.id]);
    await query('DELETE FROM categories WHERE tenant_id = ?', [k1.id]);
    const t10 = await (await fetch(TABAN + '/api/public/deneme-giris/' + r8.yer.split('/deneme-giris/')[1], { method: 'POST' })).json();
    const ucA = TABAN + '/api/marketplace/channels/' + kanal[0].id + '/menu/pull?uygula=1';
    const [p1, p2] = await Promise.all([
        fetch(ucA, { method: 'POST', headers: { Authorization: 'Bearer ' + t10.token } }),
        fetch(ucA, { method: 'POST', headers: { Authorization: 'Bearer ' + t10.token } }),
    ]);
    ok('ikisi de 200', p1.status === 200 && p2.status === 200, [p1.status, p2.status]);
    ok('toplam 3 urun, 2 kategori', (await query('SELECT (SELECT COUNT(*) FROM products WHERE tenant_id = ?) * 10 + (SELECT COUNT(*) FROM categories WHERE tenant_id = ?) AS n', [k1.id, k1.id])).rows[0].n === 32);
    ok('kategori eslemesinde store_link_id dolu', (await query("SELECT COUNT(*) c FROM marketplace_product_map WHERE tenant_id = ? AND kind = 'category' AND store_link_id IS NULL", [k1.id])).rows[0].c === 0);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
