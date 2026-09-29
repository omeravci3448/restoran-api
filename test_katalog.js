// Yerel lisans katalogu: fiyatlar ve paketler artik hub'dan degil POS'un kendi
// veritabanindan geliyor; root paneli tanimliyor.
//
// ⚠ En kritik kural: GIZLI bir satir yalnizca listede gorunmemekle kalmaz,
// SATIN DA ALINAMAZ. Yalnizca gizleseydik, istegi elle gonderen biri
// kapatilmis bir modulu yine alabilirdi.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { query, initDb } = require('./src/config/db');
const K = require('./src/services/lisansKatalog');
const A = require('./src/services/sistemAyar');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };

(async () => {
    initDb(); await uyu(1000);

    console.log('=== 1) Tohum katalog kuruldu ===');
    const tam = await K.tamKatalog();
    ok('paketler var', tam.filter(x => x.tur === 'TIER').length >= 4, tam.length);
    ok('moduller var', tam.filter(x => x.tur === 'MODUL').length >= 5);

    console.log('\n=== 2) PAZARYERI varsayilan olarak GIZLI (Patron karari) ===');
    const mp = tam.find(x => x.kod === 'MARKETPLACE');
    ok('pazaryeri satiri var', !!mp);
    ok('gorunur = 0', mp && mp.gorunur === 0, mp && mp.gorunur);
    ok('modulGorunurMu false', (await K.modulGorunurMu('MARKETPLACE')) === false);

    console.log('\n=== 3) Musteri katalogunda GIZLI satir YOK ===');
    const mus = await K.musteriKatalogu();
    ok('pazaryeri musteriye gorunmuyor',
        !mus.modules.some(m => m.name === 'MARKETPLACE'), mus.modules.map(m => m.name));
    ok('acik moduller goruunuyor', mus.modules.some(m => m.name === 'MENU_DIGITAL'));
    ok('paketler goruunuyor', mus.tiers.length >= 4);
    ok('hub alani YOK (fromHub kalmadi)', !('fromHub' in mus));

    console.log('\n=== 4) Root acinca musteriye gorunur olur ===');
    await K.guncelle(mp.id, { gorunur: 1 });
    ok('artik gorunur', (await K.modulGorunurMu('MARKETPLACE')) === true);
    ok('musteri katalogunda belirdi',
        (await K.musteriKatalogu()).modules.some(m => m.name === 'MARKETPLACE'));
    // Testi kendi haline dondur: varsayilan GIZLI olmali.
    await K.guncelle(mp.id, { gorunur: 0 });
    ok('tekrar gizlendi', (await K.modulGorunurMu('MARKETPLACE')) === false);

    console.log('\n=== 5) Fiyat ve ad guncellenebiliyor ===');
    const tier = tam.find(x => x.kod === 'TIER_6_10');
    const g = await K.guncelle(tier.id, { fiyat: 4500, ad: '6-10 Masa Paketi' });
    ok('fiyat yazildi', Number(g.fiyat) === 4500, g.fiyat);
    ok('ad yazildi', g.ad === '6-10 Masa Paketi', g.ad);
    const mk = await K.musteriKatalogu();
    ok('musteri yeni fiyati goruyor',
        mk.tiers.find(t => t.name === 'TIER_6_10').price === 4500);
    await K.guncelle(tier.id, { fiyat: 0, ad: '6-10 Masa' });

    console.log('\n=== 6) Sistem ayarlari (IBAN) ===');
    await A.yaz('iban', 'TR330006100519786457841326');
    ok('okundu', (await A.oku('iban')) === 'TR330006100519786457841326');
    ok('tanimsiz anahtar varsayilan doner', (await A.oku('yok_boyle', 'bos')) === 'bos');
    await A.yaz('iban', '');

    console.log('\n=== 7) Bilinmeyen satir guncellenemez ===');
    ok('yok olan id null doner', (await K.guncelle('YOK-123', { fiyat: 1 })) === null);

    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
