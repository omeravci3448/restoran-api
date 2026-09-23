// SofraMix POS odemesi -> kiraci acma / lisans uzatma testi.
// Odak: IDEMPOTENCY (ayni odeme iki kez lisans acmasin) ve DOGRU KIRACI esleme.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const P = require('./src/services/posProvizyon');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const gun = (n) => new Date(Date.now() + n * 86400000).toISOString();
const yeniOdeme = (x = {}) => ({
    odeme_id: 'SMX-' + uuid().slice(0, 12),
    business_id: null, isletme_adi: 'Test Lokanta', yetkili_email: null, yetkili_tel: null,
    tutar_kurus: 1200000, kdv_kurus: 240000, yontem: 'kart',
    onay_tarihi: new Date().toISOString(), ...x,
});

// Test KENDI izini siler: aksi halde ikinci kosuda 'slug zaten var' ve
// 'kac kiraci acildi' sayimlari onceki kosudan kirlenir.
const TEST_ADLARI = ['Kebapçı Şükrü', 'Deneme Lokanta', 'Ikiz Lokanta 0', 'Ikiz Lokanta 1', 'İşletme', 'Epostasiz Lokanta'];
async function temizle() {
    const t = await query(
        `SELECT id FROM tenants WHERE business_name IN (${TEST_ADLARI.map(() => '?').join(',')})`, TEST_ADLARI);
    for (const r of t.rows) {
        await query('DELETE FROM users WHERE tenant_id = ?', [r.id]);
        await query('DELETE FROM aktivasyon_jetonlari WHERE tenant_id = ?', [r.id]);
        await query('DELETE FROM deneme_kayitlari WHERE tenant_id = ?', [r.id]);
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM pos_provizyon WHERE odeme_id LIKE 'SMX-%'");
}

(async () => {
    initDb(); await uyu(900);
    await temizle();

    console.log('\n=== 1) Yeni isletme: kiraci acilir ===');
    const smx1 = 'SMXB-' + uuid().slice(0, 6);
    const o1 = yeniOdeme({ business_id: smx1, isletme_adi: 'Kebapçı Şükrü',
        yetkili_email: `s${uuid().slice(0, 6)}@ornek.test`, yetkili_tel: '0532 100 20 30' });
    const s1 = await P.odemeIsle(o1);
    ok('islendi', s1.durum === 'islendi', s1);
    ok('kiraci acildi', s1.kiraciAcildi === true);
    ok('isyeri kodu uretildi', /^\d{5,7}$/.test(String(s1.isyeriKodu)), s1.isyeriKodu);
    ok('aktivasyon jetonu dondu', !!(s1.aktivasyonJetonu && s1.aktivasyonJetonu.ham));

    const t1 = (await query('SELECT * FROM tenants WHERE id = ?', [s1.tenantId])).rows[0];
    ok('kiraci kaydi var', !!t1);
    ok('parent_org SofraMix', t1.parent_org === 'SofraMix', t1.parent_org);
    ok('aktif', t1.is_active === 1);
    ok('lisans ~365 gun',
        Math.round((new Date(t1.license_end_date) - Date.now()) / 86400000) === 365,
        t1.license_end_date);
    ok('turkce ad sluga dogru cevrildi', t1.slug === 'kebapci-sukru', t1.slug);

    const u1 = (await query('SELECT * FROM users WHERE tenant_id = ?', [s1.tenantId])).rows;
    ok('tek OWNER kullanici', u1.length === 1 && u1[0].role === 'OWNER');
    ok('sifre hashi duz sifre degil', /^\$2[aby]\$/.test(u1[0].password_hash));

    console.log('\n--- jetonun HAM hali DBde durmamali ---');
    const j = (await query('SELECT * FROM aktivasyon_jetonlari WHERE tenant_id = ?', [s1.tenantId])).rows[0];
    ok('DBde ozet duruyor',
        j.jeton_ozet === crypto.createHash('sha256').update(s1.aktivasyonJetonu.ham).digest('hex'));
    ok('DBde ham jeton YOK', j.jeton_ozet !== s1.aktivasyonJetonu.ham);

    console.log('\n=== 2) AYNI odeme tekrar gelirse (idempotency) ===');
    const s1b = await P.odemeIsle(o1);
    ok('ikinci kez islenmedi', s1b.durum === 'zaten_islendi', s1b);
    ok('ayni kiraciyi gosteriyor', s1b.tenantId === s1.tenantId);
    const t1b = (await query('SELECT license_end_date FROM tenants WHERE id = ?', [s1.tenantId])).rows[0];
    ok('LISANS UZAMADI (cift uzatma yok)', t1b.license_end_date === t1.license_end_date);
    const say = (await query('SELECT COUNT(*) c FROM tenants WHERE parent_org = ? AND business_name = ?',
        ['SofraMix', 'Kebapçı Şükrü'])).rows[0];
    ok('ikinci kiraci acilmadi', say.c === 1, say);

    console.log('\n=== 3) Ayni isletme yenilerse: lisans UZAR, kiraci acilmaz ===');
    const s2 = await P.odemeIsle(yeniOdeme({ business_id: smx1, isletme_adi: 'Kebapçı Şükrü' }));
    ok('islendi', s2.durum === 'islendi', s2);
    ok('kiraci ACILMADI', s2.kiraciAcildi === false);
    ok('ayni kiraci', s2.tenantId === s1.tenantId);
    ok('eslesme onceki odemeden', s2.esles === 'onceki_odeme', s2.esles);
    const t2 = (await query('SELECT license_end_date FROM tenants WHERE id = ?', [s1.tenantId])).rows[0];
    ok('lisans ~730 gune cikti (ustune eklendi)',
        Math.round((new Date(t2.license_end_date) - Date.now()) / 86400000) === 730,
        t2.license_end_date);

    console.log('\n=== 4) Deneme surumunu kullanan isletme satin alirsa AYNI kiraci ===');
    const smx2 = 'SMXB-' + uuid().slice(0, 6);
    const dTenant = uuid();
    await query(`INSERT INTO tenants (id, slug, business_code, business_name, license_end_date, is_active)
                 VALUES (?, ?, ?, ?, ?, 0)`,
        [dTenant, 'deneme-' + uuid().slice(0, 6), '9' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
            'Deneme Lokanta', gun(-1)]);
    await query(`INSERT INTO deneme_kayitlari (id, tenant_id, telefon_norm, soframix_business_id, isletme_adi, kaynak, bitis)
                 VALUES (?, ?, ?, ?, ?, 'soframix', ?)`,
        [uuid(), dTenant, '5327778899', smx2, 'Deneme Lokanta', gun(-1)]);

    const s3 = await P.odemeIsle(yeniOdeme({ business_id: smx2, isletme_adi: 'Deneme Lokanta' }));
    ok('deneme kiracisi bulundu', s3.tenantId === dTenant, s3);
    ok('YENI kiraci acilmadi', s3.kiraciAcildi === false);
    ok('eslesme deneme kaydindan', s3.esles === 'deneme_smx', s3.esles);
    const t3 = (await query('SELECT license_end_date, is_active FROM tenants WHERE id = ?', [dTenant])).rows[0];
    ok('suresi gecmis lisans BUGUNDEN 365 gun aldi',
        Math.round((new Date(t3.license_end_date) - Date.now()) / 86400000) === 365, t3.license_end_date);
    ok('kapali kiraci yeniden aktiflesti', t3.is_active === 1);

    console.log('\n--- SofraMix numarasi YOKSA telefondan yakalanmali ---');
    const s4 = await P.odemeIsle(yeniOdeme({ business_id: null, isletme_adi: 'Deneme Lokanta',
        yetkili_tel: '+90 532 777 88 99' }));
    ok('telefondan ayni kiraci bulundu', s4.tenantId === dTenant, s4);
    ok('eslesme telefondan', s4.esles === 'deneme_tel', s4.esles);

    console.log('\n=== 5) Ayni e-postayla BIRDEN FAZLA isletme -> elde birak ===');
    const ikizMail = `ikiz${uuid().slice(0, 6)}@ornek.test`;
    for (let i = 0; i < 2; i++) {
        await query(`INSERT INTO tenants (id, slug, business_code, business_name, owner_email, license_end_date, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, 1)`,
            [uuid(), 'ikiz-' + uuid().slice(0, 8), '8' + String(Math.floor(Math.random() * 100000)).padStart(5, '0'),
                'Ikiz Lokanta ' + i, ikizMail, gun(30)]);
    }
    const s5 = await P.odemeIsle(yeniOdeme({ yetkili_email: ikizMail, isletme_adi: 'Ikiz Lokanta' }));
    ok('elde birakildi', s5.durum === 'elde', s5);
    ok('hicbir kiraciya lisans yazilmadi', s5.tenantId == null);
    const p5 = (await query("SELECT * FROM pos_provizyon WHERE durum = 'elde' ORDER BY created_at DESC LIMIT 1")).rows[0];
    ok('para yine de kaydedildi', !!p5 && p5.tutar_kurus === 1200000, p5 && p5.tutar_kurus);

    console.log('\n=== 6) Gecersiz/eksik veri ===');
    ok('odeme_id yoksa atlanir', (await P.odemeIsle({ odeme_id: '' })).durum === 'atlandi');
    const s6 = await P.odemeIsle(yeniOdeme({ isletme_adi: '', yetkili_email: `x${uuid().slice(0, 6)}@ornek.test` }));
    ok('isletme adi bossa varsayilan ad', s6.durum === 'islendi', s6);

    console.log('\n--- yetkili e-postasi YOKSA kiraci ACILMAZ ---');
    // Eskiden uydurma bir adresle (sahip-12345@ornek.local) kiraci acilirdi:
    // lisans baslar, posta gidecek adres olmadigi icin gitmez, kimse giremez,
    // hicbir uyari cikmazdi. Simdi elle cozulmek uzere bekliyor.
    const s6b = await P.odemeIsle(yeniOdeme({ isletme_adi: 'Epostasiz Lokanta', yetkili_email: '', yetkili_tel: '' }));
    ok('elde birakildi', s6b.durum === 'elde', s6b);
    ok('sebep eposta_yok', s6b.sebep === 'eposta_yok', s6b.sebep);
    const sahte = await query("SELECT COUNT(*) c FROM users WHERE email LIKE '%@ornek.local'");
    ok('uydurma e-postali kullanici olusmadi', sahte.rows[0].c === 0, sahte.rows[0]);

    console.log('\n--- elde kalan odeme TEKRAR denenebilmeli ---');
    // En kritik kural: 'elde' satiri idempotency kapisini KAPATMAMALI, yoksa
    // sorun elle cozulse bile o odeme bir daha asla islenmezdi.
    const s6c = await P.odemeIsle({ odeme_id: (await query(
        "SELECT odeme_id FROM pos_provizyon WHERE durum = 'elde' ORDER BY created_at DESC LIMIT 1")).rows[0].odeme_id,
        isletme_adi: 'Epostasiz Lokanta', yetkili_email: `sonra${uuid().slice(0, 6)}@ornek.test`,
        tutar_kurus: 1200000, onay_tarihi: new Date().toISOString() });
    ok('cozulunce islendi', s6c.durum === 'islendi', s6c);
    ok('kiraci simdi acildi', s6c.kiraciAcildi === true);

    console.log('\n--- tarih bicimi: SofraMix "YYYY-MM-DD HH:MM:SS" gonderiyor ---');
    ok('SQLite bicimi ISOya cevriliyor',
        P.tarihNormalle('2026-09-01 08:00:00') === '2026-09-01T08:00:00.000Z',
        P.tarihNormalle('2026-09-01 08:00:00'));
    ok('ISO oldugu gibi kalir',
        P.tarihNormalle('2026-09-01T08:00:00.000Z') === '2026-09-01T08:00:00.000Z');
    ok('bozuk tarih cokertmiyor', typeof P.tarihNormalle('abc') === 'string');

    console.log('\n=== 7) Lisans bitis hesabi ===');
    ok('ileri tarihli lisans UZERINE eklenir',
        Math.round((new Date(P.yeniBitis(gun(100))) - Date.now()) / 86400000) === 465);
    ok('gecmis lisans BUGUNDEN baslar',
        Math.round((new Date(P.yeniBitis(gun(-50))) - Date.now()) / 86400000) === 365);
    ok('lisans yoksa bugunden baslar',
        Math.round((new Date(P.yeniBitis(null)) - Date.now()) / 86400000) === 365);

    console.log('\n=== 8) Slug ve telefon normalleme ===');
    ok('turkce harfler', P.slugla('Çiğköfteci Ömer Ş.') === 'cigkofteci-omer-s', P.slugla('Çiğköfteci Ömer Ş.'));
    ok('bos ad', P.slugla('') === 'isletme');
    ok('telefon son 10 hane', P.telefonNorm('+90 (532) 111-22-33') === '5321112233');
    ok('kisa telefon null', P.telefonNorm('123') === null);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
