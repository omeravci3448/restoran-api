// SofraMix odeme cekici + aktivasyon ucu: UCTAN UCA test.
// Sahte bir SofraMix platform sunucusu ayaga kaldirir, POS sunucusunu ona
// baglar, odemenin kiraciya donusup sahibinin sifre belirlemesini dogrular.
const http = require('http');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');

const SMX_PORT = 45881, POS_PORT = 45882;
const TABAN = `http://127.0.0.1:${POS_PORT}`;
const ANAHTAR = 'test-platform-anahtari';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

// --- Sahte SofraMix ---
let odemeler = [];
let gelenIstekler = [];
const smx = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    gelenIstekler.push({ yol: u.pathname, since: u.searchParams.get('since'),
        anahtar: req.headers['x-smx-platform-anahtar'] });
    if (req.headers['x-smx-platform-anahtar'] !== ANAHTAR) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'anahtar yok' }));
    }
    const since = u.searchParams.get('since');
    const liste = odemeler.filter(o => !since || new Date(o.onay_tarihi) >= new Date(since));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ odemeler: liste }));
});


// Test KENDI izini siler - aksi halde her kosu DBde bir kiraci daha birakir.
async function temizle(query) {
    const t = await query("SELECT id FROM tenants WHERE business_name = 'Uçtan Uca Lokanta'");
    for (const r of t.rows) {
        await query('DELETE FROM users WHERE tenant_id = ?', [r.id]);
        await query('DELETE FROM aktivasyon_jetonlari WHERE tenant_id = ?', [r.id]);
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM pos_provizyon WHERE odeme_id LIKE 'UC-%'");
}

async function iste(yol, yontem = 'GET', govde) {
    const r = await fetch(TABAN + yol, {
        method: yontem,
        headers: govde ? { 'Content-Type': 'application/json' } : {},
        body: govde ? JSON.stringify(govde) : undefined,
    });
    return { kod: r.status, veri: await r.json().catch(() => null) };
}

(async () => {
    await new Promise(r => smx.listen(SMX_PORT, '127.0.0.1', r));

    const sunucu = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(POS_PORT),
            SOFRAMIX_PLATFORM_URL: `http://127.0.0.1:${SMX_PORT}`,
            SOFRAMIX_PLATFORM_ANAHTAR: ANAHTAR,
            POS_PROVIZYON_ARALIK_SN: '3600',   // otomatik dongu testi bozmasin; elle tetikleyecegiz
            ROOT_EMAIL: '', ROOT_PASSWORD: '',
        },
        stdio: 'ignore',
    });
    const kapat = () => { try { sunucu.kill(); } catch (_) {} try { smx.close(); } catch (_) {} };
    process.on('exit', kapat);

    for (let i = 0; i < 40; i++) {
        try { const r = await fetch(TABAN + '/health'); if (r.ok) break; } catch (_) {}
        await uyu(400);
    }
    await uyu(1200);

    // Cekiciyi test surecinde DOGRUDAN cagiriyoruz: ayni DB dosyasi, ayni kod.
    process.env.SOFRAMIX_PLATFORM_URL = `http://127.0.0.1:${SMX_PORT}`;
    process.env.SOFRAMIX_PLATFORM_ANAHTAR = ANAHTAR;
    const cekici = require('./src/services/posOdemeCekici');
    const { query } = require('./src/config/db');
    require('./src/config/db').initDb();
    await uyu(800);
    await temizle(query);

    console.log('\n=== 1) Anahtar dogru gonderiliyor mu ===');
    ok('cekici acik', cekici.acikMi() === true);
    const bosTur = await cekici.birTur();
    ok('bos listede cokme yok', bosTur.acik === true && bosTur.gelen === 0, bosTur);
    ok('platform anahtari basliga konuldu',
        gelenIstekler.length > 0 && gelenIstekler[0].anahtar === ANAHTAR, gelenIstekler[0]);
    ok('dogru uca gidildi', gelenIstekler[0].yol === '/api/platform/pos-odemeleri', gelenIstekler[0]);
    ok('since parametresi gonderildi', !!gelenIstekler[0].since, gelenIstekler[0]);

    console.log('\n=== 2) Odeme gelince kiraci acilir ===');
    const smxId = 'B' + uuid().slice(0, 8);
    const mail = `uc${uuid().slice(0, 6)}@ornek.test`;
    odemeler = [{
        odeme_id: 'UC-' + uuid().slice(0, 10), business_id: smxId,
        isletme_adi: 'Uçtan Uca Lokanta', yetkili_email: mail, yetkili_tel: '0533 444 55 66',
        yetkili_ad: 'Deneme Sahibi', tutar_kurus: 1200000, kdv_kurus: 240000,
        yontem: 'kart', onay_tarihi: new Date().toISOString(),
    }];
    const t1 = await cekici.birTur();
    ok('1 odeme geldi', t1.gelen === 1, t1);
    ok('1 odeme islendi', t1.islenen === 1, t1);
    ok('1 kiraci acildi', t1.acilan === 1, t1);

    const k = (await query('SELECT * FROM tenants WHERE owner_email = ?', [mail])).rows[0];
    ok('kiraci DBde', !!k, k);
    ok('SofraMix kiracisi', k.parent_org === 'SofraMix');

    console.log('\n=== 3) Normal tur AYNI kaydi tekrar CEKMEZ (KVKK defteri kirlenmesin) ===');
    // SofraMix veri ciktigi HER istekte kisisel veri aktarim kaydi yaziyor.
    // Normal turda imlec son odemenin 1 sn sonrasi oldugu icin bos donmeli.
    const t2 = await cekici.birTur({ genis: false });
    ok('normal tur bos dondu', t2.gelen === 0 && t2.islenen === 0, t2);

    console.log('\n--- GENIS tur ayni kaydi getirir ama IKINCI KEZ ISLEMEZ ---');
    const t2g = await cekici.birTur({ genis: true });
    ok('genis tur kaydi tekrar getirdi', t2g.gelen === 1, t2g);
    ok('zaten islenmis sayildi', t2g.zaten === 1 && t2g.islenen === 0, t2g);
    const say = (await query('SELECT COUNT(*) c FROM tenants WHERE owner_email = ?', [mail])).rows[0];
    ok('ikinci kiraci acilmadi', say.c === 1, say);

    console.log('\n=== 4) Imlec ===');
    const nrd = await cekici.nereden(false);
    const nrdG = await cekici.nereden(true);
    ok('normal imlec son odemenin ILERISINDE (tekrar cekmesin)',
        new Date(nrd).getTime() > new Date(nrdG).getTime(), { nrd, nrdG });
    ok('genis imlec GERIYE doniyor (odeme atlamasin)',
        new Date(nrdG).getTime() < Date.now() - 5 * 3600000, nrdG);

    console.log('\n--- SofraMix tarihi ISOya cevrilerek saklaniyor ---');
    const kayit = (await query(
        'SELECT onay_tarihi FROM pos_provizyon WHERE odeme_id = ?', [odemeler[0].odeme_id])).rows[0];
    ok('onay_tarihi ISO bicimde', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(kayit.onay_tarihi), kayit.onay_tarihi);

    console.log('\n=== 5) Aktivasyon baglantisi ===');
    const jr = (await query(
        'SELECT * FROM aktivasyon_jetonlari WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [k.id])).rows[0];
    ok('jeton uretildi', !!jr);
    ok('jeton kullanilmamis', jr.kullanildi_at == null);

    // Ham jetonu testte yeniden uretemeyiz (kasten) - dogrudan servisten alalim.
    const P = require('./src/services/posProvizyon');
    const u = (await query('SELECT id FROM users WHERE tenant_id = ?', [k.id])).rows[0];
    const yeni = await P.aktivasyonJetonu(k.id, u.id);

    const kontrol = await iste(`/api/aktivasyon/${yeni.ham}`);
    ok('gecerli jeton 200', kontrol.kod === 200, kontrol);
    ok('isletme adi dondu', kontrol.veri && kontrol.veri.isletme === 'Uçtan Uca Lokanta', kontrol.veri);
    ok('isyeri kodu dondu', !!(kontrol.veri && kontrol.veri.isyeriKodu));

    const sacma = await iste('/api/aktivasyon/' + 'x'.repeat(43));
    ok('uydurma jeton 404', sacma.kod === 404, sacma);
    const kisa = await iste('/api/aktivasyon/abc');
    ok('kisa jeton 404', kisa.kod === 404, kisa);

    console.log('\n=== 6) Sifre belirleme ===');
    const kisaSifre = await iste(`/api/aktivasyon/${yeni.ham}`, 'POST', { sifre: '1234' });
    ok('kisa sifre reddedildi', kisaSifre.kod === 400, kisaSifre);

    const kur = await iste(`/api/aktivasyon/${yeni.ham}`, 'POST', { sifre: 'GucluSifre2026' });
    ok('sifre belirlendi', kur.kod === 200 && kur.veri.ok === true, kur);

    console.log('\n--- ayni baglanti IKINCI kez calismamali ---');
    const tekrar = await iste(`/api/aktivasyon/${yeni.ham}`, 'POST', { sifre: 'BaskaSifre2026' });
    ok('tekrar kullanim 410', tekrar.kod === 410, tekrar);
    const tekrarGet = await iste(`/api/aktivasyon/${yeni.ham}`);
    ok('kontrol de 410 diyor', tekrarGet.kod === 410, tekrarGet);

    console.log('\n--- ayni kiracinin ESKI jetonu da kapanmali ---');
    const eskiKontrol = (await query(
        'SELECT COUNT(*) c FROM aktivasyon_jetonlari WHERE tenant_id = ? AND kullanildi_at IS NULL', [k.id])).rows[0];
    ok('bekleyen jeton kalmadi', eskiKontrol.c === 0, eskiKontrol);

    console.log('\n=== 7) Yeni sifreyle GIRIS ===');
    const giris = await iste('/api/auth/login', 'POST',
        { email: kur.veri.eposta, businessCode: kur.veri.isyeriKodu, password: 'GucluSifre2026' });
    ok('giris basarili', giris.kod === 200 && !!giris.veri.token, giris);

    console.log('\n=== 8) Suresi gecmis jeton ===');
    const gecmis = await P.aktivasyonJetonu(k.id, u.id, -1);   // 1 saat once bitmis
    const g = await iste(`/api/aktivasyon/${gecmis.ham}`);
    ok('suresi gecmis jeton 410', g.kod === 410, g);
    ok('sebep suresi_doldu', g.veri && g.veri.sebep === 'suresi_doldu', g.veri);

    console.log('\n=== 9) SofraMix anahtari yanlissa ===');
    process.env.SOFRAMIX_PLATFORM_ANAHTAR = 'yanlis';
    delete require.cache[require.resolve('./src/services/posOdemeCekici')];
    const cekici2 = require('./src/services/posOdemeCekici');
    let patladi = false;
    try { await cekici2.birTur(); } catch (e) { patladi = /401/.test(e.message); }
    ok('yanlis anahtar hata veriyor (sessizce gecmiyor)', patladi === true);

    await temizle(query);
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    kapat();
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
