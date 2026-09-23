// SofraMix menu ucu - GERCEK sozlesmeye gore test. Ag YOK, yanit fixture.
// Yanit sekli Patron'un verdigi gercek ciktidan birebir alindi.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { getAdapter } = require('./src/marketplace/registry');
const M = require('./src/marketplace/adapters/soframix/mapping');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };

// --- GERCEK SofraMix yaniti ---
const YANIT = {
    categories: [{ id: 1, business_id: 1, name: 'Pideler', sort: 0 },
                 { id: 3, business_id: 1, name: 'Icecekler', sort: 1 }],
    products: [
        { id: 6, business_id: 1, category_id: 3, name: 'Ayran (buyuk)', description: '',
          price_kurus: 3000, image_url: null, is_active: 1, sort: 0,
          enerji_kcal: 120, porsiyon_gram: null, icindekiler: '',
          alerjen: { beyan: true, icerir: ['sut'], iz: ['susam'], alkol: false, domuz: false } },
        // Tum "farkli yazilan" kodlar - esleme calisiyor mu?
        { id: 7, business_id: 1, category_id: 1, name: 'Karisik Pide', description: 'Bol malzemeli',
          price_kurus: 18500, image_url: '/uploads/b1-abc.webp', is_active: 1, sort: 1,
          enerji_kcal: 780, porsiyon_gram: 350, icindekiler: 'un, maya, kiyma',
          alerjen: { beyan: true, icerir: ['gluten', 'kabuklu', 'yerfistigi', 'sertkabuklu', 'lupen'],
                     iz: [], alkol: false, domuz: false } },
        // BEYAN EDILMEMIS - "alerjen yok" DEGIL
        { id: 8, business_id: 1, category_id: 1, name: 'Kasarli Pide', description: '',
          price_kurus: 16000, image_url: null, is_active: 1, sort: 2,
          enerji_kcal: null, porsiyon_gram: null, icindekiler: '',
          alerjen: { beyan: false, icerir: [], iz: [], alkol: false, domuz: false } },
        // Alkol + domuz + bilinmeyen kod
        { id: 9, business_id: 1, category_id: 3, name: 'Sarap', description: '',
          price_kurus: 45000, image_url: null, is_active: 1, sort: 3,
          enerji_kcal: null, porsiyon_gram: null, icindekiler: '',
          alerjen: { beyan: true, icerir: ['sulfit', 'YENI_KOD_X'], iz: [], alkol: true, domuz: false } },
    ],
};

(async () => {
    const smx = getAdapter('soframix');
    let istek = null;
    const ctx = {
        tenantId: 'T', credentials: { apiBase: 'https://soframix.com.tr', apiKey: 'smx_test' },
        storeLink: { externalStoreId: '1' },
        http: async (u, o) => { istek = { u, o }; return { ok: true, status: 200, text: async () => JSON.stringify(YANIT) }; },
    };

    console.log('\n=== 1) Istek sekli (sozlesmeye uyuyor mu) ===');
    const menu = await smx.pullMenu(ctx);
    ok('dogru uc', istek.u === 'https://soframix.com.tr/api/business/menu', istek.u);
    ok('YALNIZ GET (yazma yolu yok)', istek.o.method === 'GET', istek.o.method);
    ok('X-Smx-Anahtar basligi', istek.o.headers['X-Smx-Anahtar'] === 'smx_test');

    console.log('\n=== 2) Kategori + urun ===');
    ok('2 kategori', menu.kategoriler.length === 2);
    ok('4 urun', menu.urunler.length === 4);
    const ayran = menu.urunler[0], pide = menu.urunler[1], kasarli = menu.urunler[2], sarap = menu.urunler[3];

    console.log('\n=== 3) FIYAT: kurus -> tasinmaz, bilgi olarak saklanir ===');
    ok('fiyat 0 geldi', ayran.priceKurus === 0);
    ok('urun PASIF', ayran.isActive === false);
    ok('platform fiyati kurus olarak saklandi (3000 = 30 TL)', ayran.platformPriceKurus === 3000);

    console.log('\n=== 4) ALERJEN KODU ESLEMESI (4 kod farkli yaziliyor) ===');
    const kodlar = JSON.parse(pide.allergens);
    ok('kabuklu -> kabuklu_deniz', kodlar.includes('kabuklu_deniz'), kodlar);
    ok('yerfistigi -> yer_fistigi', kodlar.includes('yer_fistigi'), kodlar);
    ok('sertkabuklu -> sert_kabuklu', kodlar.includes('sert_kabuklu'), kodlar);
    ok('lupen -> lupin', kodlar.includes('lupin'), kodlar);
    ok('gluten aynen', kodlar.includes('gluten'));
    ok('5 kodun hepsi cevrildi', kodlar.length === 5, kodlar);

    console.log('\n=== 5) BEYAN EDILMEMIS "alerjen yok" DEGIL ===');
    ok('beyan yoksa allergens NULL (bos dizi DEGIL)', kasarli.allergens === null, kasarli.allergens);
    ok('beyan bayragi false', kasarli.allergenBeyan === false);
    ok('beyan edilmis urunde bayrak true', ayran.allergenBeyan === true);
    ok('beyansiz urun sayisi raporlandi', menu.beyansizUrun === 1, menu.beyansizUrun);

    console.log('\n=== 6) IZ, icerdigiyle KARISTIRILMIYOR ===');
    ok('iz alerjen listesine EKLENMEDI', JSON.parse(ayran.allergens).join() === 'sut',
        ayran.allergens);
    ok('iz icindekiler metninde belirtildi', /İz olarak içerebilir.*susam/.test(ayran.ingredients || ''),
        ayran.ingredients);

    console.log('\n=== 7) Diger Seffaf Menu alanlari ===');
    ok('kalori tasindi', ayran.calories === 120);
    ok('porsiyon null gecti', ayran.portionGrams === null);
    ok('gramaj tasindi', pide.portionGrams === 350);
    ok('icindekiler tasindi', /un, maya, kiyma/.test(pide.ingredients || ''), pide.ingredients);
    ok('bos icindekiler null oldu', kasarli.ingredients === null, kasarli.ingredients);
    ok('alkol isaretlendi', sarap.containsAlcohol === 1);
    ok('domuz isaretlenmedi', sarap.containsPork === 0);
    ok('gorsel tasindi', pide.imageUrl === '/uploads/b1-abc.webp');

    console.log('\n=== 8) BILINMEYEN KOD sessizce atilmiyor, raporlaniyor ===');
    ok('bilinmeyen kod yakalandi', menu.bilinmeyenAlerjenKodu.includes('YENI_KOD_X'),
        menu.bilinmeyenAlerjenKodu);
    ok('bilinen kod yine de gecti', JSON.parse(sarap.allergens).includes('sulfit'));

    console.log('\n=== 9) 14 kodun tamami eslesiyor mu ===');
    const hepsi = ['gluten','kabuklu','yumurta','balik','yerfistigi','soya','sut',
                   'sertkabuklu','kereviz','hardal','susam','sulfit','lupen','yumusakca'];
    const c = M.alerjenCevir(hepsi);
    ok('14/14 cevrildi, bilinmeyen yok', c.kodlar.length === 14 && c.bilinmeyen.length === 0,
        { cevrilen: c.kodlar.length, bilinmeyen: c.bilinmeyen });

    console.log('\nSONUC: ' + pass + ' gecti, ' + fail + ' kaldi');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
