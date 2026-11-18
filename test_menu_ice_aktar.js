// Menu ice aktarma (root): POST /api/root/tenants/:id/menu-ice-aktar
// Onizleme yazmaz / aktarma yazar, JSON ve CSV, ekle / guncelle, dogrulama hatalari, hata olunca tum islemin
// geri alinmasi (tetikleyiciyle zorlanir), yalniz root, yonetim gunlugu. Sunucuyu KENDI baslatir (port 47800).
// Calistir: node test_menu_ice_aktar.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47800, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'menu-ice-aktar-test-jwt';
const ON = 'K3MIA Test';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body } = {}) {
    const r = await fetch(TABAN + yol, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['products', 'categories', 'yonetim_gunlugu', 'users']) await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    const rr = await query("SELECT id FROM root_users WHERE email LIKE 'k3mia-root-%'");
    for (const r of rr.rows) await query('DELETE FROM yonetim_gunlugu WHERE root_id = ?', [r.id]).catch(() => {});
    await query("DELETE FROM root_users WHERE email LIKE 'k3mia-root-%'");
    await query('DROP TRIGGER IF EXISTS k3mia_hata').catch(() => {});
}

const urunler = (tid) => query(
    'SELECT p.*, c.name AS kat FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.tenant_id = ? ORDER BY p.name', [tid]).then((r) => r.rows);
const kategoriler = (tid) => query('SELECT * FROM categories WHERE tenant_id = ? ORDER BY sort_order', [tid]).then((r) => r.rows);
const gunluk = (tid) => query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'menu_ice_aktar'", [tid]).then((r) => r.rows);
const tumGunluk = (tid) => query('SELECT * FROM yonetim_gunlugu WHERE tenant_id = ?', [tid]).then((r) => r.rows);
const bul = (liste, ad) => liste.find((u) => u.name === ad);

(async () => {
    initDb(); await uyu(900); await temizle();
    const env = { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' };
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);

    // Kurulum: root, isletme (sahip), mevcut kategori + urun
    const rootId = uuid();
    await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
        [rootId, `k3mia-root-${rootId.slice(0, 6)}@ornek.test`, 'x', 'Test Root']);
    const rj = jwt.sign({ rootId, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' });
    const tid = uuid(), uid = uuid();
    await query('INSERT INTO tenants (id, slug, business_name) VALUES (?, ?, ?)', [tid, 'k3mia-' + tid.slice(0, 8), `${ON} Lokanta`]);
    await query("INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, 'x', 'Sahip', 'OWNER')",
        [uid, tid, `k3mia-sahip-${tid.slice(0, 6)}@ornek.test`]);
    const katCorba = uuid();
    await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, 3)', [katCorba, tid, 'Çorbalar']);
    await query(`INSERT INTO products (id, tenant_id, category_id, name, description, price, tracks_stock, is_available, sort_order)
                 VALUES (?, ?, ?, 'Mercimek Çorbası', 'Eski açıklama', 80, 0, 0, 1)`, [uuid(), tid, katCorba]);
    const YOL = `/api/root/tenants/${tid}/menu-ice-aktar`;

    console.log('=== 1) Yetki ve temel dogrulama ===');
    const ornek = { bicim: 'json', veri: '{"urunler":[{"kategori":"A","ad":"B","fiyat":1}]}', mod: 'ekle', onizleme: true };
    ok('jetonsuz 401', (await js(YOL, { body: ornek })).status === 401);
    const kiraciJeton = jwt.sign({ userId: uid, tenantId: tid, role: 'OWNER' }, JWT_SECRET, { expiresIn: '1h' });
    const k = await js(YOL, { token: kiraciJeton, body: ornek });
    ok('isletme jetonu 403 (yalniz root)', k.status === 403, k);
    ok('olmayan isletme 404', (await js(`/api/root/tenants/${uuid()}/menu-ice-aktar`, { token: rj, body: ornek })).status === 404);
    ok('gecersiz bicim 400', (await js(YOL, { token: rj, body: { ...ornek, bicim: 'xml' } })).status === 400);
    ok('gecersiz mod 400', (await js(YOL, { token: rj, body: { ...ornek, mod: 'sil' } })).status === 400);
    ok('bos veri 400', (await js(YOL, { token: rj, body: { ...ornek, veri: '   ' } })).status === 400);

    console.log('\n=== 2) JSON onizleme: hicbir sey yazmaz ===');
    const menu1 = {
        kategoriler: [{ ad: 'Çorbalar' }, { ad: 'Tatlılar', sira: 20 }, { ad: 'tatlılar' }],
        urunler: [
            { kategori: 'Çorbalar', ad: 'Mercimek Çorbası', fiyat: 90 },
            { kategori: 'ÇORBALAR', ad: 'Ezogelin Çorbası', fiyat: '85,50', aciklama: 'Limon ile' },
            { kategori: 'Tatlılar', ad: 'Künefe', fiyat: 150, alerjenler: ['sut', 'Gluten', 'xyz'], icindekiler: 'Kadayıf, peynir', kalori: 520, porsiyon: 200,
              gorsel: 'https://ornek.test/kunefe.jpg' },
            { kategori: 'Tatlılar', ad: 'Sütlaç' },
            { kategori: 'Tatlılar', ad: 'künefe', fiyat: 160 },
            { kategori: 'İçecekler', ad: 'Ayran', fiyat: 25, aktif: false, gorsel: 'http://guvensiz.test/a.jpg' },
        ],
    };
    const urunOnce = (await urunler(tid)).length, katOnce = (await kategoriler(tid)).length;
    let r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(menu1), mod: 'ekle', onizleme: true } });
    ok('onizleme 200', r.status === 200 && r.d.onizleme === true, r.d);
    ok('sayilar: 2 yeni kategori (Tatlılar, İçecekler), 1 mevcut', r.d.sayilar.kategoriYeni === 2 && r.d.sayilar.kategoriMevcut === 1, r.d.sayilar);
    ok('sayilar: 4 yeni urun, 0 guncellenen, 2 atlanan', r.d.sayilar.urunYeni === 4 && r.d.sayilar.urunGuncellenen === 0 && r.d.sayilar.urunAtlanan === 2, r.d.sayilar);
    ok('mevcut urun atlandi (ayni kategori ayni ad)', r.d.atlanan.some((a) => a.ad === 'Mercimek Çorbası' && /zaten var/.test(a.neden)), r.d.atlanan);
    ok('dosyada tekrar eden ad atlandi + uyari', r.d.atlanan.some((a) => a.ad === 'künefe') && r.d.uyarilar.some((u) => /iki kez/.test(u)), r.d);
    ok('tekrar eden kategori uyarisi', r.d.uyarilar.some((u) => /kategorisi listede iki kez/.test(u)), r.d.uyarilar);
    ok('fiyatsiz urun uyarisi + 0 TL pasif', r.d.uyarilar.some((u) => /Sütlaç.*fiyat yok/.test(u)) && r.d.yeni.some((u) => u.ad === 'Sütlaç' && u.fiyat === 0 && u.aktif === false), r.d);
    ok('tanınmayan alerjen kodu uyarisi', r.d.uyarilar.some((u) => /Tanınmayan alerjen.*xyz/.test(u)), r.d.uyarilar);
    ok('listede olmayan kategori uyarisi', r.d.uyarilar.some((u) => /listesinde olmayan.*İçecekler/.test(u)), r.d.uyarilar);
    ok('https olmayan gorsel uyarisi', r.d.uyarilar.some((u) => /Ayran.*https/.test(u)), r.d.uyarilar);
    ok('alerjen beyani olmayan urun uyarisi', r.d.uyarilar.some((u) => /alerjen bilgisi yok/.test(u)), r.d.uyarilar);
    ok('hata yok, aktarilabilir', r.d.hatalar.length === 0 && r.d.aktarilabilir === true, r.d.hatalar);
    ok('onizlemede urun YAZILMADI', (await urunler(tid)).length === urunOnce);
    ok('onizlemede kategori YAZILMADI', (await kategoriler(tid)).length === katOnce);
    ok('onizleme yonetim gunlugune dusmez', (await tumGunluk(tid)).length === 0, await tumGunluk(tid));

    console.log('\n=== 3) JSON aktarma (ekle) ===');
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(menu1), mod: 'ekle', onizleme: false } });
    ok('aktarma 200 ok', r.status === 200 && r.d.ok === true && r.d.onizleme === false, r.d);
    let U = await urunler(tid), K = await kategoriler(tid);
    ok('urun sayisi 1 + 4', U.length === 5, U.map((u) => u.name));
    ok('kategori sayisi 1 + 2', K.length === 3, K.map((k) => k.name));
    ok('Tatlılar sirasi dosyadan (20)', K.find((x) => x.name === 'Tatlılar').sort_order === 20, K);
    ok('İçecekler sirasi mevcutlarin arkasinda', K.find((x) => x.name === 'İçecekler').sort_order > 3, K);
    const ezo = bul(U, 'Ezogelin Çorbası');
    ok('Ezogelin mevcut Çorbalar kategorisine (buyuk harf eslesmesi)', ezo && ezo.category_id === katCorba, ezo);
    ok('Ezogelin fiyati 85,50 -> 85.5, aktif, stok takibi yok', ezo.price === 85.5 && ezo.is_available === 1 && ezo.tracks_stock === 0 && ezo.description === 'Limon ile', ezo);
    const kun = bul(U, 'Künefe');
    ok('Künefe alerjenleri kodlu (bilinmeyen atildi)', kun.allergens === '["sut","gluten"]', kun.allergens);
    ok('Künefe seffaf menu alanlari + gorsel', kun.ingredients === 'Kadayıf, peynir' && kun.calories === 520 && kun.portion_grams === 200
        && kun.image_url === 'https://ornek.test/kunefe.jpg', kun);
    ok('Sütlaç 0 TL ve PASIF', bul(U, 'Sütlaç').price === 0 && bul(U, 'Sütlaç').is_available === 0, bul(U, 'Sütlaç'));
    ok('Sütlaç alerjen NULL (beyan yok)', bul(U, 'Sütlaç').allergens === null);
    ok('Ayran pasif (aktif:false), gorsel yazilmadi', bul(U, 'Ayran').is_available === 0 && bul(U, 'Ayran').image_url === null, bul(U, 'Ayran'));
    const merc = bul(U, 'Mercimek Çorbası');
    ok('mevcut urun DOKUNULMADI (ekle modu)', merc.price === 80 && merc.description === 'Eski açıklama', merc);
    let G = await gunluk(tid);
    ok('yonetim gunlugune bir satir', G.length === 1 && /4 yeni ürün/.test(G[0].ozet) && G[0].root_id === rootId, G);

    console.log('\n=== 4) Ayni dosya tekrar: mukerrer olusmaz ===');
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(menu1), mod: 'ekle', onizleme: false } });
    ok('0 yeni urun, 0 yeni kategori', r.status === 200 && r.d.sayilar.urunYeni === 0 && r.d.sayilar.kategoriYeni === 0, r.d.sayilar);
    ok('urun sayisi hala 5', (await urunler(tid)).length === 5);

    console.log('\n=== 5) Guncelle modu ===');
    const menu2 = { urunler: [
        { kategori: 'Çorbalar', ad: 'mercimek çorbası', fiyat: 95, aciklama: 'Yeni açıklama' },
        { kategori: 'Çorbalar', ad: 'Ezogelin Çorbası', fiyat: 85.5 },
        { kategori: 'Tatlılar', ad: 'Sütlaç' },
        { kategori: 'Tatlılar', ad: 'Künefe', fiyat: 175, alerjenler: ['sut', 'gluten', 'sert kabuklu'] },
        { kategori: 'Tatlılar', ad: 'Kazandibi', fiyat: 110 },
    ] };
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(menu2), mod: 'guncelle', onizleme: true } });
    ok('onizleme: 2 guncellenen, 1 yeni, 2 atlanan', r.d.sayilar.urunGuncellenen === 2 && r.d.sayilar.urunYeni === 1 && r.d.sayilar.urunAtlanan === 2, r.d);
    ok('Mercimek eski/yeni fiyat listede', r.d.guncellenen.some((g) => g.ad === 'Mercimek Çorbası' && g.eskiFiyat === 80 && g.yeniFiyat === 95 && g.aciklamaDegisti), r.d.guncellenen);
    ok('Ezogelin "Değişiklik yok"', r.d.atlanan.some((a) => a.ad === 'Ezogelin Çorbası' && a.neden === 'Değişiklik yok'), r.d.atlanan);
    ok('fiyatsiz mevcut urunde fiyat korunur uyarisi', r.d.uyarilar.some((u) => /Sütlaç.*mevcut fiyat korunur/.test(u)), r.d.uyarilar);
    ok('onizlemede fiyat degismedi', bul(await urunler(tid), 'Mercimek Çorbası').price === 80);
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(menu2), mod: 'guncelle', onizleme: false } });
    ok('guncelle aktarimi 200', r.status === 200 && r.d.ok, r.d);
    U = await urunler(tid);
    const merc2 = bul(U, 'Mercimek Çorbası');
    ok('Mercimek fiyat + aciklama guncellendi', merc2.price === 95 && merc2.description === 'Yeni açıklama', merc2);
    ok('Mercimek satis durumu DEGISMEDI (pasif kaldi)', merc2.is_available === 0, merc2.is_available);
    ok('Künefe fiyat + alerjen guncellendi', bul(U, 'Künefe').price === 175 && bul(U, 'Künefe').allergens === '["sut","gluten","sert_kabuklu"]', bul(U, 'Künefe'));
    ok('Künefe dosyada olmayan alanlari korundu', bul(U, 'Künefe').ingredients === 'Kadayıf, peynir' && bul(U, 'Künefe').image_url === 'https://ornek.test/kunefe.jpg');
    ok('Sütlaç fiyati korundu (0)', bul(U, 'Sütlaç').price === 0);
    ok('Kazandibi eklendi', !!bul(U, 'Kazandibi'));
    ok('hicbir urun silinmedi (5 + 1)', U.length === 6 && !!bul(U, 'Ayran'), U.map((u) => u.name));
    G = await gunluk(tid);
    ok('guncelle gunlukte (güncelle, eski/yeni fiyat ayrintida)', G.length === 3 && G.some((g) => /güncelle/.test(g.ozet) && /"eskiFiyat":80/.test(g.ayrinti || '')), G.map((g) => g.ozet));

    console.log('\n=== 6) CSV (noktali virgul ve virgul) ===');
    const csv1 = '﻿kategori;urun;fiyat;aciklama;aktif;not\r\n'
        + 'Izgaralar;Adana Kebap;"320,00";"Acılı; közlenmiş biber ile";evet;x\r\n'
        + '\r\n'
        + 'Izgaralar;"Kuzu ""Şiş""";1.250;;hayır;\r\n'
        + 'çorbalar;Mercimek Çorbası;99;;;\r\n'
        + 'Izgaralar;Köfte;12a;;;\r\n';
    r = await js(YOL, { token: rj, body: { bicim: 'csv', veri: csv1, mod: 'ekle', onizleme: true } });
    ok('CSV onizleme: fiyat okunamadi hatasi, aktarilamaz', r.status === 200 && r.d.hatalar.some((h) => /5\. satır|6\. satır/.test(h) && /fiyat okunamadı/.test(h)) && r.d.aktarilabilir === false, r.d);
    ok('tanınmayan sutun uyarisi', r.d.uyarilar.some((u) => /Tanınmayan sütunlar.*not/.test(u)), r.d.uyarilar);
    const csv1b = csv1.replace('Köfte;12a', 'Köfte;"210"');
    r = await js(YOL, { token: rj, body: { bicim: 'csv', veri: csv1b, mod: 'ekle', onizleme: true } });
    ok('CSV onizleme: 3 yeni, 1 atlanan (kucuk harf kategori eslesmesi)', r.d.sayilar.urunYeni === 3 && r.d.sayilar.urunAtlanan === 1 && r.d.sayilar.kategoriYeni === 1, r.d);
    r = await js(YOL, { token: rj, body: { bicim: 'csv', veri: csv1b, mod: 'ekle', onizleme: false } });
    ok('CSV aktarma 200', r.status === 200 && r.d.ok, r.d);
    U = await urunler(tid);
    ok('Adana: 320, aciklamada noktali virgul korundu', bul(U, 'Adana Kebap').price === 320 && bul(U, 'Adana Kebap').description === 'Acılı; közlenmiş biber ile', bul(U, 'Adana Kebap'));
    ok('Kuzu "Şiş": tirnak cozuldu, 1.250 -> 1250, pasif', bul(U, 'Kuzu "Şiş"') && bul(U, 'Kuzu "Şiş"').price === 1250 && bul(U, 'Kuzu "Şiş"').is_available === 0, U.map((u) => u.name));
    ok('Köfte eklendi', bul(U, 'Köfte') && bul(U, 'Köfte').price === 210);
    const csv2 = 'Kategori,Ürün,Fiyat,Açıklama,Aktif\nIzgaralar,Adana Kebap,"340,5",,\nIzgaralar,Beyti,360,"Yoğurtlu, tereyağlı",1\n';
    r = await js(YOL, { token: rj, body: { bicim: 'csv', veri: csv2, mod: 'guncelle', onizleme: false } });
    ok('virgullu CSV + Turkce baslik, guncelle 200', r.status === 200 && r.d.sayilar.urunGuncellenen === 1 && r.d.sayilar.urunYeni === 1, r.d);
    U = await urunler(tid);
    ok('Adana 340.5, Beyti aciklamasi virgullu', bul(U, 'Adana Kebap').price === 340.5 && bul(U, 'Beyti').description === 'Yoğurtlu, tereyağlı', [bul(U, 'Adana Kebap'), bul(U, 'Beyti')]);
    r = await js(YOL, { token: rj, body: { bicim: 'csv', veri: 'kategori;ad\nA;B\n', mod: 'ekle', onizleme: true } });
    ok('CSV eksik sutun hatasi', r.d.hatalar.some((h) => /sütunlar yok: fiyat/.test(h)), r.d.hatalar);

    console.log('\n=== 7) Dogrulama hatalari: aktarma reddedilir, hicbir sey yazilmaz ===');
    const bozuk = { urunler: [
        { kategori: 'Yeni Bölüm', ad: 'Geçerli Ürün', fiyat: 10 },
        { kategori: 'Yeni Bölüm', fiyat: 10 },
        { kategori: '', ad: 'Kategorisiz', fiyat: 10 },
        { kategori: 'Yeni Bölüm', ad: 'Eksi', fiyat: -5 },
        { kategori: 'Yeni Bölüm', ad: 'Harfli', fiyat: 'on lira' },
    ] };
    const sayOnce = (await urunler(tid)).length, katSayOnce = (await kategoriler(tid)).length, gunlukOnce = (await tumGunluk(tid)).length;
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(bozuk), mod: 'ekle', onizleme: true } });
    ok('onizleme 4 hata listeler', r.status === 200 && r.d.hatalar.length === 4 && r.d.aktarilabilir === false, r.d.hatalar);
    ok('hata metinleri: ad bos, kategori bos, eksi, okunamadi', /ürün adı boş/.test(r.d.hatalar.join('|')) && /kategori boş/.test(r.d.hatalar.join('|'))
        && /eksi olamaz/.test(r.d.hatalar.join('|')) && /okunamadı/.test(r.d.hatalar.join('|')), r.d.hatalar);
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(bozuk), mod: 'ekle', onizleme: false } });
    ok('hatali dosya aktarilamaz (400)', r.status === 400 && r.d.hatalar.length === 4, r);
    ok('gecerli satir da yazilmadi', (await urunler(tid)).length === sayOnce && (await kategoriler(tid)).length === katSayOnce);
    ok('reddedilen aktarma gunluge dusmez', (await tumGunluk(tid)).length === gunlukOnce);
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: '{"urunler": [ {"kategori": "A", ', mod: 'ekle', onizleme: true } });
    ok('bozuk JSON: okunamadi hatasi', r.status === 200 && /JSON okunamadı/.test(r.d.hatalar[0] || ''), r.d);
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: '{"kategoriler": []}', mod: 'ekle', onizleme: true } });
    ok('urunler listesi yok hatasi', /"urunler" listesi bulunamadı/.test(r.d.hatalar[0] || ''), r.d);
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: '```json\n{"urunler": []}\n```', mod: 'ekle', onizleme: true } });
    ok('kod blogu isaretleri ayiklanir; bos liste hatasi', /Dosyada ürün yok/.test(r.d.hatalar[0] || ''), r.d);

    console.log('\n=== 8) Yazma sirasinda hata: TUM islem geri alinir ===');
    await query("CREATE TRIGGER IF NOT EXISTS k3mia_hata BEFORE INSERT ON products WHEN NEW.name = 'K3 Hata Ürünü' BEGIN SELECT RAISE(ABORT, 'test hatasi'); END");
    const geri = { kategoriler: [{ ad: 'Geçici Kategori' }], urunler: [
        { kategori: 'Geçici Kategori', ad: 'Önce Yazılan', fiyat: 10 },
        { kategori: 'Çorbalar', ad: 'Mercimek Çorbası', fiyat: 999 },
        { kategori: 'Geçici Kategori', ad: 'K3 Hata Ürünü', fiyat: 10 },
    ] };
    const once8 = (await urunler(tid)).length;
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify(geri), mod: 'guncelle', onizleme: false } });
    ok('500 + hicbir degisiklik yapilmadi mesaji', r.status === 500 && /hiçbir değişiklik yapılmadı/.test(r.d.message || ''), r);
    U = await urunler(tid); K = await kategoriler(tid);
    ok('kategori geri alindi', !K.some((x) => x.name === 'Geçici Kategori'), K.map((x) => x.name));
    ok('once yazilan urun geri alindi', !bul(U, 'Önce Yazılan') && U.length === once8, U.map((u) => u.name));
    ok('guncelleme de geri alindi (Mercimek 95)', bul(U, 'Mercimek Çorbası').price === 95, bul(U, 'Mercimek Çorbası').price);
    await query('DROP TRIGGER IF EXISTS k3mia_hata');
    r = await js(YOL, { token: rj, body: { bicim: 'json', veri: JSON.stringify({ urunler: [{ kategori: 'Çorbalar', ad: 'Tarhana', fiyat: 70 }] }), mod: 'ekle', onizleme: false } });
    ok('hatadan sonra yazma calisiyor (kilit takilmadi)', r.status === 200 && bul(await urunler(tid), 'Tarhana'), r);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
