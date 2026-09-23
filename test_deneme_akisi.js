// 7 gunluk deneme akisi + yenileme kanali testi.
// Deneme servisi yazilmisti ama URETIMDE HIC CAGRILMIYORDU: deneme_kayitlari
// hep bos kaliyor, "bir kez deneme" korumasi da provizyondaki "denemeden gecen
// isletme AYNI kiraciyi surdursun" basamagi da fiilen calismiyordu.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const D = require('./src/services/denemeLisansi');
const P = require('./src/services/posProvizyon');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };

const ADLAR = ['Deneme Akis Lokanta', 'Ikinci Deneme Lokanta'];
async function temizle() {
    const t = await query(
        `SELECT id FROM tenants WHERE business_name IN (${ADLAR.map(() => '?').join(',')})`, ADLAR);
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari']) {
            await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE telefon_norm IN ('5551110011','5551110022')");
}

(async () => {
    initDb(); await uyu(900);
    await temizle();

    console.log('=== 1) Deneme baslatinca kiraci ACILIYOR ===');
    const mail = `d${uuid().slice(0, 8)}@ornek.test`;
    const s1 = await D.denemeBaslat({
        isletmeAdi: 'Deneme Akis Lokanta', yetkiliAd: 'Ali Usta',
        eposta: mail, telefon: '0555 111 00 11', kaynak: 'tanitim' });
    ok('acildi', s1.durum === 'acildi', s1);
    ok('7 gun', s1.gun === 7, s1.gun);
    ok('isyeri kodu var', /^\d{5,7}$/.test(String(s1.isyeriKodu)), s1.isyeriKodu);
    ok('aktivasyon jetonu var', !!(s1.aktivasyonJetonu && s1.aktivasyonJetonu.ham));

    const t1 = (await query('SELECT * FROM tenants WHERE id = ?', [s1.tenantId])).rows[0];
    ok('tier TIER_DENEME', t1.license_tier === 'TIER_DENEME', t1.license_tier);
    ok('lisans ~7 gun',
        Math.round((new Date(t1.license_end_date) - Date.now()) / 86400000) === 7, t1.license_end_date);
    ok('aktif', t1.is_active === 1);
    const u1 = (await query('SELECT * FROM users WHERE tenant_id = ?', [s1.tenantId])).rows;
    ok('OWNER kullanici acildi', u1.length === 1 && u1[0].role === 'OWNER');

    console.log('\n=== 2) Deneme kaydi yazildi (BIR KEZ korumasi calisir hale geldi) ===');
    const dk = (await query('SELECT * FROM deneme_kayitlari WHERE tenant_id = ?', [s1.tenantId])).rows[0];
    ok('kayit var', !!dk, dk);
    ok('telefon normalize', dk && dk.telefon_norm === '5551110011', dk && dk.telefon_norm);

    console.log('\n=== 3) AYNI telefon ikinci kez deneme ALAMAZ ===');
    const s2 = await D.denemeBaslat({
        isletmeAdi: 'Ikinci Deneme Lokanta', yetkiliAd: 'Veli',
        eposta: `x${uuid().slice(0, 8)}@ornek.test`, telefon: '+90 555 111 00 11' });
    ok('reddedildi', s2.durum === 'zaten_alinmis', s2);
    const say = (await query("SELECT COUNT(*) c FROM tenants WHERE business_name = 'Ikinci Deneme Lokanta'")).rows[0];
    ok('ikinci kiraci acilmadi', say.c === 0, say);

    console.log('\n--- ayni E-POSTA ile de acilamaz ---');
    const s3 = await D.denemeBaslat({
        isletmeAdi: 'Ikinci Deneme Lokanta', yetkiliAd: 'Veli',
        eposta: mail, telefon: '0555 111 00 22' });
    ok('reddedildi', s3.durum === 'zaten_alinmis', s3);

    console.log('\n=== 4) Eksik bilgi ===');
    ok('e-posta yoksa acilmaz',
        (await D.denemeBaslat({ isletmeAdi: 'X', telefon: '05551110033' })).sebep === 'eposta_gecersiz');
    ok('bozuk e-posta reddedilir',
        (await D.denemeBaslat({ isletmeAdi: 'X', eposta: 'abc', telefon: '05551110033' })).sebep === 'eposta_gecersiz');
    ok('telefon yoksa acilmaz',
        (await D.denemeBaslat({ isletmeAdi: 'X', eposta: 'a@b.com', telefon: '123' })).sebep === 'telefon_gecersiz');

    console.log('\n=== 5) Denemeden SATIN ALMAYA gecince AYNI kiraci ===');
    // Provizyondaki 'deneme_tel' basamagi artik gercekten calisiyor.
    const smx = await P.kiraciBul({ smxId: null, tel: '0555 111 00 11', eposta: null });
    ok('deneme kiracisi bulundu', smx.tenantId === s1.tenantId, smx);
    ok('eslesme deneme kaydindan', smx.esles === 'deneme_tel', smx.esles);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
