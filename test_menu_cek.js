// "Pazaryerinden menuyu cek" akisi - gercek denetleyici, gercek DB, AG YOK.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const kur = require('./src/controllers/channelSetupController');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
function res() { const r = { kod: 200, veri: null };
    r.status = (c) => { r.kod = c; return r; }; r.json = (o) => { r.veri = o; return r; }; return r; }
const cagir = async (fn, req) => { const r = res(); await fn(req, r); return r; };

(async () => {
    initDb(); await uyu(900);
    const tid = 'MC-' + uuid().slice(0, 6), chId = uuid();
    const user = { tenantId: tid, id: uuid(), role: 'OWNER' };
    await query('INSERT INTO tenants (id, slug, business_name) VALUES (?,?,?)', [tid, 'mc-' + tid, 'Menu Cek Test']);
    await query('INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code) VALUES (?,?,?,?)',
        [chId, tid, 'Test Pazaryeri', 'sandbox']);

    console.log('\n=== 1) Baglanti kurulmadan menu cekilemez ===');
    let r = await cagir(kur.pullMenu, { user, params: { id: chId }, query: {} });
    ok('once baglanti isteniyor', r.kod === 400, r.veri);

    console.log('\n=== 2) Anahtar kaydet + dogrula ===');
    r = await cagir(kur.saveCredentials, { user, params: { id: chId },
        body: { fields: { apiKey: 'TEST' }, externalStoreId: 'SBX-STORE-1' } });
    ok('baglanti kuruldu', r.kod === 200 && r.veri.ok === true, r.veri);
    ok('parmak izi maskeli dondu', /^AK-••••/.test(r.veri.fingerprint || ''), r.veri.fingerprint);
    const ham = (await query('SELECT cipher_blob FROM marketplace_credentials WHERE tenant_id=?', [tid])).rows[0];
    ok('anahtar DBde SIFRELI (duz metin yok)', !String(ham.cipher_blob).includes('TEST'));

    console.log('\n=== 3) Onizleme: hicbir sey YAZMAZ ===');
    r = await cagir(kur.pullMenu, { user, params: { id: chId }, query: {} });
    ok('onizleme dondu', r.veri.onizleme === true, r.veri);
    ok('2 yeni urun gorundu', r.veri.urun.yeni === 2, r.veri.urun);
    const yazildiMi = (await query('SELECT COUNT(*) c FROM products WHERE tenant_id=?', [tid])).rows[0].c;
    ok('onizlemede DBye YAZILMADI', yazildiMi === 0, yazildiMi);

    console.log('\n=== 4) Uygula: menu aktarilir ===');
    r = await cagir(kur.pullMenu, { user, params: { id: chId }, query: { uygula: '1' } });
    ok('2 urun + 1 kategori eklendi', r.veri.urunEklendi === 2 && r.veri.kategoriEklendi === 1, r.veri);
    ok('uyari notu dondu', /PAS[İI]F/i.test(r.veri.uyari || ''), r.veri.uyari);

    const urunler = (await query('SELECT * FROM products WHERE tenant_id=? ORDER BY name', [tid])).rows;
    ok('urunler DBde', urunler.length === 2, urunler.length);
    ok('FIYAT 0 geldi', urunler.every(u => Number(u.price) === 0), urunler.map(u => u.price));
    ok('MALIYET bos geldi', urunler.every(u => Number(u.cost) === 0));
    ok('urunler PASIF (kazara satilamaz)', urunler.every(u => u.is_available === 0));
    ok('stok takibi kapali geldi', urunler.every(u => u.tracks_stock === 0));
    ok('kategoriye baglandi', urunler.every(u => !!u.category_id));

    console.log('\n=== 5) Esleme defteri yazildi (ikinci cekiste mukerrer olmasin) ===');
    const esl = (await query("SELECT * FROM marketplace_product_map WHERE tenant_id=? AND kind='product'", [tid])).rows;
    ok('2 urun eslemesi', esl.length === 2, esl.length);
    ok('pazaryeri fiyati bilgi olarak saklandi', esl.every(e => Number(e.external_price) > 0), esl.map(e => e.external_price));

    console.log('\n=== 6) TEKRAR cekilince MUKERRER URUN OLUSMAZ ===');
    r = await cagir(kur.pullMenu, { user, params: { id: chId }, query: { uygula: '1' } });
    ok('yeni urun eklenmedi', r.veri.urunEklendi === 0, r.veri);
    const say = (await query('SELECT COUNT(*) c FROM products WHERE tenant_id=?', [tid])).rows[0].c;
    ok('urun sayisi hala 2', say === 2, say);

    console.log('\n=== 7) Urun-kanal baglantisi sorgulanabiliyor (fiyat hatirlatmasi icin) ===');
    r = await cagir(kur.productLinks, { user, params: { productId: urunler[0].id } });
    ok('bagli kanal donuyor', Array.isArray(r.veri) && r.veri.length === 1, r.veri);

    console.log('\n=== 8) Kanal durumu ozeti ===');
    r = await cagir(kur.channelStatus, { user, params: { id: chId } });
    ok('kimlik parmak izi var, ham anahtar YOK', !!r.veri.kimlik?.fingerprint && r.veri.kimlik.cipher_blob === undefined);
    ok('eslesen urun sayisi dogru', r.veri.eslesenUrun === 2, r.veri.eslesenUrun);

    // temizlik
    await query('DELETE FROM marketplace_product_map WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_store_links WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_credentials WHERE tenant_id=?', [tid]);
    await query('DELETE FROM products WHERE tenant_id=?', [tid]);
    await query('DELETE FROM categories WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_channels WHERE tenant_id=?', [tid]);
    await query('DELETE FROM tenants WHERE id=?', [tid]);
    console.log('\nSONUC: ' + pass + ' gecti, ' + fail + ' kaldi (temizlendi)');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
