// Lisans durum makinesi + 7 gunluk deneme korumasi testi.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const L = require('./src/services/lisansDurumu');
const D = require('./src/services/denemeLisansi');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const gun = (n) => new Date(Date.now() + n * 86400000);

(async () => {
    initDb(); await uyu(900);

    console.log('\n=== 1) Lisans durumlari ===');
    ok('bitise 5 gun var -> AKTIF', L.hesapla(gun(5)).durum === L.DURUM.AKTIF);
    ok('bugun bitiyor ama gecmedi -> AKTIF', L.hesapla(new Date(Date.now() + 60000)).durum === L.DURUM.AKTIF);
    ok('1 gun gecti -> SALT_OKUNUR', L.hesapla(gun(-1)).durum === L.DURUM.SALT_OKUNUR);
    ok('3 gun gecti -> hala SALT_OKUNUR', L.hesapla(gun(-3)).durum === L.DURUM.SALT_OKUNUR);
    ok('5 gun gecti -> KAPALI', L.hesapla(gun(-5)).durum === L.DURUM.KAPALI);
    ok('tarih yoksa AKTIF (sinirsiz)', L.hesapla(null).durum === L.DURUM.AKTIF);
    ok('bozuk tarih cokertmiyor', L.hesapla('bozuk-tarih').durum === L.DURUM.AKTIF);

    console.log('\n--- "3. gunun sonunda gece 00:00" siniri ---');
    // Lisans 10 gun once bitmis gibi degil; tam sinirda davranisa bakalim.
    const bitis = new Date(); bitis.setDate(bitis.getDate() - 3); bitis.setHours(10, 0, 0, 0);
    const tolBitis = L.hesapla(bitis).toleransBitis;
    ok('tolerans gun SONUNDA bitiyor (23:59)',
        tolBitis.getHours() === 23 && tolBitis.getMinutes() === 59, tolBitis && tolBitis.toString());
    const gecTest = new Date(tolBitis.getTime() - 1000);        // gece yarisindan 1 sn once
    const sonraTest = new Date(tolBitis.getTime() + 1000);      // 1 sn sonra
    ok('gece yarisindan once SALT_OKUNUR', L.hesapla(bitis, gecTest).durum === L.DURUM.SALT_OKUNUR);
    ok('gece yarisindan sonra KAPALI', L.hesapla(bitis, sonraTest).durum === L.DURUM.KAPALI);

    console.log('\n=== 2) Salt-okunur modda ne gecer ===');
    const istek = (m, u) => ({ method: m, originalUrl: u });
    ok('GET gecer', L.saltOkunurdaGecerMi(istek('GET', '/api/orders')) === true);
    ok('POST siparis GECMEZ', L.saltOkunurdaGecerMi(istek('POST', '/api/orders')) === false);
    ok('POST odeme GECMEZ', L.saltOkunurdaGecerMi(istek('POST', '/api/payments')) === false);
    ok('LISANS ucu gecer (odeme yapabilsin)', L.saltOkunurdaGecerMi(istek('POST', '/api/license/purchase')) === true);
    ok('AUTH gecer (giris yapabilsin)', L.saltOkunurdaGecerMi(istek('POST', '/api/auth/login')) === true);

    console.log('\n=== 3) Telefon normalleme ===');
    const t = D.telefonNormalle;
    ok('bosluklu', t('0532 111 22 33') === '5321112233', t('0532 111 22 33'));
    ok('+90 onekli', t('+90 532 111 22 33') === '5321112233', t('+90 532 111 22 33'));
    ok('0 siz', t('5321112233') === '5321112233');
    ok('parantezli-tireli', t('(0532) 111-22-33') === '5321112233');
    ok('kisa numara null', t('12345') === null);
    ok('bos null', t('') === null && t(null) === null);

    console.log('\n=== 4) "BIR KEZ deneme" korumasi ===');
    const tid = 'DN-' + uuid().slice(0, 6);
    ok('once deneme yok', (await D.oncekiDeneme({ telefon: '0532 999 88 77' })) === null);
    const k = await D.denemeKaydet({ tenantId: tid, telefon: '0532 999 88 77',
        isletmeAdi: 'Test Lokanta', kaynak: 'dogrudan' });
    ok('deneme kaydedildi', !!k.id);
    ok('bitis 7 gun sonrasi',
        Math.round((k.bitis - Date.now()) / 86400000) === 7, Math.round((k.bitis - Date.now()) / 86400000));

    console.log('\n--- AYNI telefon, FARKLI yazim -> yine yakalanmali ---');
    ok('+90 ile deneyen yakalandi', !!(await D.oncekiDeneme({ telefon: '+90 532 999 88 77' })));
    ok('parantezli deneyen yakalandi', !!(await D.oncekiDeneme({ telefon: '(0532) 999-88-77' })));
    ok('BASKA telefon serbest', (await D.oncekiDeneme({ telefon: '0533 000 11 22' })) === null);

    console.log('\n--- SofraMix isletme numarasi olcutu ---');
    const tid2 = 'DN2-' + uuid().slice(0, 6);
    await D.denemeKaydet({ tenantId: tid2, telefon: '0544 000 00 01',
        soframixBusinessId: '77', isletmeAdi: 'SMX Lokanta', kaynak: 'soframix' });
    ok('ayni SofraMix no yakalandi', !!(await D.oncekiDeneme({ telefon: '0599 111 11 11', soframixBusinessId: '77' })));
    ok('farkli SofraMix no serbest', (await D.oncekiDeneme({ telefon: '0599 111 11 11', soframixBusinessId: '78' })) === null);

    console.log('\n--- Kiraci SILINSE BILE kayit kalir (tekrar deneme alinamaz) ---');
    await query('DELETE FROM tenants WHERE id = ?', [tid]);
    ok('kiraci silindi ama deneme kaydi duruyor', !!(await D.oncekiDeneme({ telefon: '0532 999 88 77' })));

    await query("DELETE FROM deneme_kayitlari WHERE tenant_id IN (?, ?)", [tid, tid2]);
    console.log('\nSONUC: ' + pass + ' gecti, ' + fail + ' kaldi (temizlendi)');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
