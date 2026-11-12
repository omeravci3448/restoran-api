// MDA Yazilim Magazasi: root yetkisi (urun/siparis/ayar uclari root ister; isletme baska isletmenin
// siparisini goremez), rol + yonetici sifresi, taslak urun gorunmezligi, tutar hesabi (KDV, kargo, esik;
// istemci fiyati yok sayilir), stok ayirma ve iade, durum gecisleri + gecersiz gecislerin reddi,
// isletmenin iptal kurali, yumusak silme sonrasi siparis kopyasi, resim turu ve boyut denetimi,
// magaza kapaliyken uclar, fatura bilgisinin isletmeye donmemesi, bildirim (root_olaylar +
// /api/root/cihaz/bildirim-durumu), satis kosullari surumu, acik siparis siniri.
// Sunucuyu KENDI baslatir.  Calistir: node test_magaza.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');
const totp = require('./src/services/totp');
const { UPLOADS_DIR } = require('./src/services/imageService');

const PORT = 45991, TABAN = `http://127.0.0.1:${PORT}`;
const ROOT_EPOSTA = 'rootmagaza@ornek.test', ROOT_PAROLA = 'MagazaTestParola123';
const AD_A = 'Magaza Test Lokanta', AD_B = 'Magaza Test Kafe';
const ONEK = 'MGTEST ';
const AYARLAR = ['magaza_acik', 'magaza_kargo_ucret_kurus', 'magaza_kargo_esik_kurus', 'magaza_satis_kosullari', 'magaza_otomatik_iptal_gun',
    'magaza_satici_unvan', 'magaza_satici_adres', 'magaza_satici_vergi_dairesi', 'magaza_satici_vkn', 'magaza_satici_telefon', 'magaza_satici_eposta',
    'iban', 'iban_sahibi', 'banka_adi', 'odeme_aciklama', 'bildirim_eposta'];
const SATICI = { unvan: 'MDA Yazılım Test Satıcı', adres: 'Örnek Mah. Test Cad. No 1, Merkez, Afyonkarahisar', vergiDairesi: 'Tınaztepe',
    vkn: '1234567890', telefon: '0272 000 00 00', eposta: 'magaza-satici@ornek.test' };
const UNVAN_A = 'Magaza Test Gida Ticaret Ltd. Sti.';
const VKN_A = '4840847211';
const TCKN = '10000000146';            // gecerli kontrol haneli deneme numarasi

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
async function bekle(kosul, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const r = await kosul().catch(() => null); if (r) return r; await uyu(150); }
    return null;
}
async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPG1 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const WEBP1 = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const pngBoyut = (n) => 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n - 8, 7)]).toString('base64');
const dosyaVar = (yol) => !!yol && fs.existsSync(path.join(UPLOADS_DIR, 'magaza', path.basename(yol)));

let ayarYedek = {};
async function ayarlariYedekle() {
    const r = await query(`SELECT anahtar, deger FROM sistem_ayarlari WHERE anahtar IN (${AYARLAR.map(() => '?').join(',')})`, AYARLAR);
    ayarYedek = Object.fromEntries(r.rows.map(x => [x.anahtar, x.deger]));
}
async function ayarlariGeriYukle() {
    for (const k of AYARLAR) {
        if (Object.prototype.hasOwnProperty.call(ayarYedek, k)) await query('UPDATE sistem_ayarlari SET deger = ? WHERE anahtar = ?', [ayarYedek[k], k]);
        else await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [k]);
    }
}
async function temizle() {
    const t = await query('SELECT id FROM tenants WHERE business_name IN (?, ?)', [AD_A, AD_B]);
    for (const r of t.rows) {
        const sip = await query('SELECT id FROM magaza_siparisler WHERE tenant_id = ?', [r.id]).catch(() => ({ rows: [] }));
        for (const s of sip.rows) {
            await query('DELETE FROM magaza_siparis_gecmisi WHERE siparis_id = ?', [s.id]);
            await query('DELETE FROM magaza_siparis_kalemleri WHERE siparis_id = ?', [s.id]);
            await query('DELETE FROM magaza_siparisler WHERE id = ?', [s.id]);
        }
        await query('DELETE FROM root_olaylar WHERE tenant_id = ?', [r.id]).catch(() => {});
        for (const tb of ['lisans_odemeleri', 'license_cache', 'islem_gunlugu', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    const u = await query("SELECT id FROM magaza_urunler WHERE ad LIKE 'MGTEST %'").catch(() => ({ rows: [] }));
    for (const x of u.rows) {
        const res = await query('SELECT yol FROM magaza_urun_resimleri WHERE urun_id = ?', [x.id]);
        for (const y of res.rows) fs.rmSync(path.join(UPLOADS_DIR, 'magaza', path.basename(y.yol)), { force: true });
        await query('DELETE FROM magaza_urun_resimleri WHERE urun_id = ?', [x.id]);
        await query('DELETE FROM magaza_urunler WHERE id = ?', [x.id]);
    }
    const ru = await query('SELECT id FROM root_users WHERE email = ?', [ROOT_EPOSTA]);
    for (const x of ru.rows) await query('DELETE FROM root_cihazlar WHERE root_id = ?', [x.id]).catch(() => {});
    await query('DELETE FROM root_users WHERE email = ?', [ROOT_EPOSTA]);
}

(async () => {
    initDb(); await uyu(900);
    await temizle();
    await ayarlariYedekle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), ROOT_EMAIL: ROOT_EPOSTA, ROOT_PASSWORD: ROOT_PAROLA,
               JWT_SECRET: 'magaza-test-jwt', HUB_URL: 'http://127.0.0.1:9', NODE_ENV: 'development' } });
    const kapat = () => { try { sunucu.kill(); } catch (_) {} };
    process.on('exit', kapat);
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(6500);   // ensureRootUser 5 sn sonra calisir

    console.log('=== Hazirlik: root oturumu, iki isletme (A kurum, B deneme), mudur + kasiyer ===');
    let r = await js('/api/root/login', { body: { email: ROOT_EPOSTA, password: ROOT_PAROLA } });
    r = await js('/api/root/totp/kurulum', { body: { code: totp.kodUret(r.d.sir, totp.suankiAdim()) }, token: r.d.kurulumJetonu });
    const ROOT = r.d && r.d.token;
    ok('root oturumu', !!ROOT, r);
    const isletmeAc = async (ad, eposta) => {
        const t = await js('/api/root/tenants', { token: ROOT, body: { businessName: ad, ownerEmail: eposta, ownerPassword: 'sahip12345',
            phone: '0272 111 22 33', address: 'Dumlupınar Mah. Kurtuluş Cad. No 12, Merkez, Afyonkarahisar', parentOrg: 'Test' } });
        const g = await js('/api/auth/login', { body: { email: eposta, businessCode: t.d.businessCode, password: 'sahip12345' } });
        return { id: t.d.id, kod: t.d.businessCode, token: g.d.token };
    };
    const A = await isletmeAc(AD_A, 'magaza-a@ornek.test');
    const Bi = await isletmeAc(AD_B, 'magaza-b@ornek.test');
    ok('iki isletme acildi + sahip girisi', !!A.token && !!Bi.token, [A, Bi]);
    // Onayli ucretli lisans odemesi olan isletme lisansli sayilir (acik siparis siniri 5); olmayan deneme (sinir 1)
    const lisansla = (tid) => query("INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum) VALUES (?, ?, 'TIER_1_5', '[]', 1000, 'onaylandi')",
        [require('crypto').randomUUID(), tid]);
    await lisansla(A.id);
    await query("UPDATE tenants SET license_tier = 'TIER_DENEME', license_end_date = ? WHERE id = ?",
        [new Date(Date.now() + 7 * 86400000).toISOString(), Bi.id]);
    await js('/api/auth/staff', { token: A.token, body: { email: 'mudur@ornek.test', password: 'mudur12345', name: 'Müdür Ayşe', role: 'MANAGER' } });
    await js('/api/auth/staff', { token: A.token, body: { email: 'kasa@ornek.test', password: 'kasa12345', name: 'Kasiyer Ali', role: 'CASHIER' } });
    const MUDUR = (await js('/api/auth/login', { body: { email: 'mudur@ornek.test', businessCode: A.kod, password: 'mudur12345' } })).d.token;
    const KASA = (await js('/api/auth/login', { body: { email: 'kasa@ornek.test', businessCode: A.kod, password: 'kasa12345' } })).d.token;
    ok('mudur + kasiyer girisi', !!MUDUR && !!KASA);
    const cihaz = await js('/api/root/cihaz/kaydet', { token: ROOT, body: { ad: 'Magaza Test Telefonu' } });
    const BJ = cihaz.d && cihaz.d.bildirimJetonu;
    const d0 = await js('/api/root/cihaz/bildirim-durumu', { body: { bildirimJetonu: BJ, olaySonId: 0 } });   // tarama burada calisir
    const S0 = d0.d && d0.d.olay ? d0.d.olay.sonId : 0;
    ok('bildirim jetonu + baslangic olay no', !!BJ && d0.status === 200 && Number.isFinite(S0), d0);

    const R = (yol, o = {}) => js('/api/root/magaza' + yol, { token: ROOT, ...o });
    const M = (tok) => (yol, o = {}) => js('/api/magaza' + yol, { token: tok, ...o });
    const MA_ = M(A.token), MB = M(Bi.token);

    console.log('\n=== 1) Root yetkisi: urun / siparis / ayar uclari root ister ===');
    ok('oturumsuz root urun listesi 401', (await js('/api/root/magaza/urunler')).status === 401);
    ok('isletme jetonuyla root urun listesi 403', (await js('/api/root/magaza/urunler', { token: A.token })).status === 403);
    ok('isletme jetonuyla urun ekleme 403', (await js('/api/root/magaza/urunler', { token: A.token, body: { ad: ONEK + 'Sizinti' } })).status === 403);
    ok('isletme jetonuyla root siparis listesi 403', (await js('/api/root/magaza/siparisler', { token: A.token })).status === 403);
    ok('isletme jetonuyla ayar degistirme 403', (await js('/api/root/magaza/ayarlar', { token: A.token, method: 'PUT', body: { acik: true } })).status === 403);
    ok('mudur jetonuyla root ozet 403', (await js('/api/root/magaza/ozet', { token: MUDUR })).status === 403);
    ok('root ile urun listesi 200', (await R('/urunler')).status === 200);

    console.log('\n=== 2) Magaza KAPALI iken ===');
    let a = await R('/ayarlar', { method: 'PUT', body: { acik: false } });
    ok('root magazayi kapatti', a.status === 200 && a.d.acik === false, a);
    let d = await MA_('/durum');
    ok('durum 200: acik=false, aktif siparis 0', d.status === 200 && d.d.acik === false && d.d.aktifSiparis === 0, d);
    ok('urun listesi 403 MAGAZA_KAPALI', (d = await MA_('/urunler')).status === 403 && d.d.code === 'MAGAZA_KAPALI', d);
    ok('sepet 403 MAGAZA_KAPALI', (d = await MA_('/sepet', { body: { kalemler: [] } })).status === 403 && d.d.code === 'MAGAZA_KAPALI', d);
    ok('hazirlik 403', (await MA_('/hazirlik')).status === 403);
    ok('siparis olusturma 403 MAGAZA_KAPALI', (d = await MA_('/siparisler', { body: { kalemler: [{ urunId: 'x', adet: 1 }] } })).status === 403 && d.d.code === 'MAGAZA_KAPALI', d);
    ok('siparislerim kapaliyken de 200 (bos)', (d = await MA_('/siparisler')).status === 200 && Array.isArray(d.d) && d.d.length === 0, d);

    console.log('\n=== 3) Rol: kasiyer giremez, mudur girer ===');
    ok('kasiyer /durum 403', (await M(KASA)('/durum')).status === 403);
    ok('kasiyer /siparisler 403', (await M(KASA)('/siparisler')).status === 403);
    ok('mudur /durum 200', (await M(MUDUR)('/durum')).status === 200);

    console.log('\n=== 4) Urun ekleme + dogrulama ===');
    ok('adsiz urun 400', (await R('/urunler', { body: { fiyat: 10 } })).status === 400);
    ok('negatif fiyat 400', (await R('/urunler', { body: { ad: ONEK + 'X', fiyat: -5 } })).status === 400);
    ok('fiyatsiz urun yayina alinamaz 400', (await R('/urunler', { body: { ad: ONEK + 'X', fiyat: 0, yayin: 'YAYINDA' } })).status === 400);
    ok('gecersiz stok durumu 400', (await R('/urunler', { body: { ad: ONEK + 'X', stokDurumu: 'BOL' } })).status === 400);
    ok('degersiz teknik ozellik satiri 400', (await R('/urunler', { body: { ad: ONEK + 'X', ozellikler: [{ ad: 'Ekran', deger: '' }] } })).status === 400);
    ok('KDV 101 reddedilir 400', (await R('/urunler', { body: { ad: ONEK + 'X', kdvOrani: 101 } })).status === 400);
    const p1 = (await R('/urunler', { body: { ad: ONEK + 'Dokunmatik POS', kategori: 'Bilgisayar', kisaAciklama: '15,6 inç dokunmatik',
        uzunAciklama: 'Kasa için hazır.\n\n- Sessiz çalışır\n- Fansız', ozellikler: [{ ad: 'Ekran', deger: '15,6 inç' }, { ad: 'RAM', deger: '8 GB' }],
        fiyat: 10000, kdvOrani: 20, yayin: 'YAYINDA' } })).d;
    const p2 = (await R('/urunler', { body: { ad: ONEK + 'Termal Rulo', kategori: 'Sarf', fiyat: 33.33, kdvOrani: 20, stokAdedi: 5, yayin: 'YAYINDA' } })).d;
    const p3 = (await R('/urunler', { body: { ad: ONEK + 'Taslak Yazici', kategori: 'Yazıcı', fiyat: 500 } })).d;
    const p4 = (await R('/urunler', { body: { ad: ONEK + 'Mutfak Yazicisi', kategori: 'Yazıcı', fiyat: '2500', kdvOrani: 10,
        stokDurumu: 'SIPARIS_UZERINE', tedarikGun: 7, yayin: 'YAYINDA' } })).d;
    const p5 = (await R('/urunler', { body: { ad: ONEK + 'Elle Tukendi', fiyat: 100, stokDurumu: 'TUKENDI', yayin: 'YAYINDA' } })).d;
    const p6 = (await R('/urunler', { body: { ad: ONEK + 'Esik Urunu', fiyat: 1666.67, kdvOrani: 20, yayin: 'YAYINDA' } })).d;
    ok('urunler eklendi', [p1, p2, p3, p4, p5, p6].every(x => x && x.id), [p1, p2, p3, p4, p5, p6].map(x => x && (x.id || x.message)));
    ok('fiyat kurusa cevrildi + KDV dahil hesaplandi', p1.fiyatKurus === 1000000 && p1.fiyatKdvDahilKurus === 1200000
        && p2.fiyatKurus === 3333 && p2.fiyatKdvDahilKurus === 4000 && p6.fiyatKdvDahilKurus === 200000, [p1.fiyatKurus, p2.fiyatKdvDahilKurus, p6.fiyatKdvDahilKurus]);
    ok('yeni urun varsayilan TASLAK', p3.yayin === 'TASLAK', p3.yayin);
    ok('teknik ozellikler kaydedildi', p1.ozellikler.length === 2 && p1.ozellikler[1].deger === '8 GB', p1.ozellikler);
    let g = await R('/urunler/' + p1.id, { method: 'PUT', body: { kisaAciklama: '15,6 inç dokunmatik, fansız' } });
    ok('kismi guncelleme 200, diger alanlar korunur', g.status === 200 && g.d.kisaAciklama.includes('fansız') && g.d.fiyatKurus === 1000000, g.d);
    ok('olmayan urun guncelleme 404', (await R('/urunler/yok-boyle-bir-urun', { method: 'PUT', body: { ad: 'X Y' } })).status === 404);
    let rl = await R('/urunler');
    ok('root listesi taslak dahil hepsini gorur + kategori onerileri', rl.d.urunler.filter(x => x.ad.startsWith(ONEK)).length === 6
        && rl.d.kategoriler.includes('Bilgisayar') && rl.d.kategoriler.includes('Yazıcı'), rl.d.kategoriler);
    ok('elle Tukendi -> etkin stok TUKENDI', rl.d.urunler.find(x => x.id === p5.id).etkinStok === 'TUKENDI');

    console.log('\n=== 5) Magaza ACIK: satici bilgisi sart; taslak urun isletmeye hic gorunmez ===');
    for (const ad of AYARLAR.filter(x => x.startsWith('magaza_satici_'))) await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [ad]);
    a = await R('/ayarlar', { method: 'PUT', body: { acik: true } });
    ok('satici bilgisi eksikken magaza acilamaz (409 SATICI_BILGISI_EKSIK, 6 eksik)', a.status === 409 && a.d.code === 'SATICI_BILGISI_EKSIK' && a.d.eksik.length === 6, a);
    ok('11 haneli (TC) satici numarasi 400', (await R('/ayarlar', { method: 'PUT', body: { satici: { vkn: '10000000146' } } })).status === 400);
    ok('gecersiz satici e-postasi 400', (await R('/ayarlar', { method: 'PUT', body: { satici: { eposta: 'eposta-degil' } } })).status === 400);
    a = await R('/ayarlar', { method: 'PUT', body: { satici: { ...SATICI, vkn: '123 456 78 90' } } });
    ok('satici bilgileri kaydedildi (VKN bosluklu yazim kabul)', a.status === 200 && a.d.saticiEksik.length === 0 && a.d.satici.vkn === '1234567890' && a.d.acik === false, a.d);
    a = await R('/ayarlar', { method: 'PUT', body: { acik: true, kargoUcret: 150, kargoUcretsizEsik: 2000 } });
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('iban', 'TR00 0000 0000 0000 0000 0000 00') ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger");
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('iban_sahibi', 'MDA Yazilim Test') ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger");
    ok('ayarlar: acik + kargo 15000 kurus + esik 200000 kurus', a.d.acik === true && a.d.kargoUcretKurus === 15000 && a.d.kargoEsikKurus === 200000, a.d);
    ok('durum acik=true', (await MA_('/durum')).d.acik === true);
    let ul = await MA_('/urunler');
    const idler = ul.d.urunler.map(x => x.id);
    ok('liste 200: yayindakiler var, TASLAK yok', ul.status === 200 && idler.includes(p1.id) && idler.includes(p2.id) && idler.includes(p4.id) && !idler.includes(p3.id), idler.length);
    ok('isletme listesinde stok adedi ve maliyet alani yok', ul.d.urunler.every(x => !('stokAdedi' in x) && !('yayin' in x)), Object.keys(ul.d.urunler[0] || {}));
    ok('kategori filtresi taslak kategorisini icermez degil: Yazıcı yayindaki P4 sayesinde var', ul.d.kategoriler.includes('Yazıcı'));
    ok('taslak urun ayrintisi 404', (await MA_('/urunler/' + p3.id)).status === 404);
    let ud = await MA_('/urunler/' + p4.id);
    ok('ayrinti: siparis uzerine 7 gun', ud.status === 200 && ud.d.stok.durum === 'SIPARIS_UZERINE' && ud.d.stok.tedarikGun === 7, ud.d.stok);
    ud = await MA_('/urunler/' + p1.id);
    ok('ayrinti: uzun aciklama + teknik ozellikler', ud.d.uzunAciklama.includes('- Fansız') && ud.d.ozellikler.length === 2, ud.d);
    let s = await MA_('/sepet', { body: { kalemler: [{ urunId: p3.id, adet: 1 }, { urunId: p1.id, adet: 1 }] } });
    ok('sepet: taslak urun hesaba girmez (SATISTA_DEGIL)', s.status === 200 && s.d.kalemler.length === 1 && s.d.sorunlar[0].sebep === 'SATISTA_DEGIL', s.d);

    console.log('\n=== 6) Tutar hesabi (KDV, kargo, esik; istemci fiyati yok sayilir) ===');
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p2.id, adet: 3, fiyat: 1, birimKurus: 1, toplamKurus: 1 }] } });
    let k = s.d.kalemler[0];
    ok('istemci fiyati yok: birim 3333, tutar 9999', k.birimKurus === 3333 && k.tutarKurus === 9999, k);
    ok('KDV satir tutarindan: round(1999,8) = 2000', k.kdvKurus === 2000 && k.toplamKurus === 11999, k);
    ok('esik alti: kargo 15000, genel 26999, eksik 188001', s.d.kargoKurus === 15000 && s.d.genelToplamKurus === 26999 && s.d.kargo.eksikKurus === 188001, s.d);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p6.id, adet: 1 }] } });
    ok('tam esikte (KDV dahil 2000,00) kargo ucretsiz', s.d.kargoKurus === 0 && s.d.kargo.ucretsiz === true && s.d.genelToplamKurus === 200000, s.d);
    await R('/ayarlar', { method: 'PUT', body: { kargoUcretsizEsik: '2000,01' } });
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p6.id, adet: 1 }] } });
    ok('esigin 1 kurus altinda kargo alinir', s.d.kargoKurus === 15000 && s.d.genelToplamKurus === 215000, s.d);
    await R('/ayarlar', { method: 'PUT', body: { kargoUcret: 0 } });
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p2.id, adet: 1 }] } });
    ok('kargo ucreti 0 ise her zaman ucretsiz', s.d.kargoKurus === 0 && s.d.genelToplamKurus === 4000, s.d);
    await R('/ayarlar', { method: 'PUT', body: { kargoUcret: 150, kargoUcretsizEsik: 2000 } });
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p1.id, adet: 1 }, { urunId: p4.id, adet: 1 }] } });
    ok('farkli KDV oranlari: ara 1.250.000, KDV 225.000, kargo 0', s.d.araToplamKurus === 1250000 && s.d.kdvKurus === 225000
        && s.d.kargoKurus === 0 && s.d.genelToplamKurus === 1475000, s.d);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p2.id, adet: 1 }, { urunId: p2.id, adet: 2 }] } });
    ok('ayni urun iki satir birlesir (3 adet)', s.d.kalemler.length === 1 && s.d.kalemler[0].adet === 3, s.d.kalemler);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p5.id, adet: 1 }] } });
    ok('elle Tukendi urun sepete girmez', s.d.kalemler.length === 0 && s.d.sorunlar[0].sebep === 'TUKENDI', s.d);
    ok('adet 0 -> 400', (await MA_('/sepet', { body: { kalemler: [{ urunId: p1.id, adet: 0 }] } })).status === 400);
    ok('adet 1,5 -> 400', (await MA_('/sepet', { body: { kalemler: [{ urunId: p1.id, adet: 1.5 }] } })).status === 400);
    ok('adet 1000 -> 400', (await MA_('/sepet', { body: { kalemler: [{ urunId: p1.id, adet: 1000 }] } })).status === 400);
    ok('bos sepet 200 sifir', (s = await MA_('/sepet', { body: { kalemler: [] } })).status === 200 && s.d.genelToplamKurus === 0, s.d);

    console.log('\n=== 7) Siparis olusturma + girdi denetimi ===');
    const h = await MA_('/hazirlik');
    ok('hazirlik: teslimat isletme bilgisinden on dolu, kosullar + surum, yalniz havale', h.status === 200 && h.d.teslimat.alici === AD_A
        && h.d.teslimat.adres.includes('Dumlupınar') && typeof h.d.kosullar.surum === 'string' && h.d.kosullar.metin.includes('14 gün')
        && h.d.odemeYontemleri.length === 1 && h.d.odemeYontemleri[0].kod === 'HAVALE' && h.d.odemeHazir === true, h.d);
    ok('varsayilan kosullar tuketici ifadesi icermez', !/cayma|tüketici|hakem heyeti/i.test(h.d.kosullar.metin));
    ok('kosullarin basinda satici bilgileri + yeni maddeler, jeton kalmamis', h.d.kosullar.metin.startsWith('Satıcı bilgileri')
        && h.d.kosullar.metin.includes(SATICI.unvan) && h.d.kosullar.metin.includes(SATICI.vkn) && h.d.kosullar.metin.includes(SATICI.eposta)
        && ['Afyonkarahisar Mahkemeleri ve İcra Daireleri', '7 iş günü', 'tutanağı', '/kvkk', 'bariz', 'ticari ya da mesleki', '7 gün içinde ödemesi satıcı hesabına ulaşmazsa kendiliğinden iptal edilir']
            .every(x => h.d.kosullar.metin.includes(x)) && !h.d.kosullar.metin.includes('{{'), h.d.kosullar.metin.slice(0, 300));
    const teslimat = { alici: 'Ahmet Yılmaz', telefon: '0532 111 22 33', adres: 'Dumlupınar Mah. Kurtuluş Cad. No 12, Merkez, Afyonkarahisar' };
    const faturaA = { tip: 'KURUMSAL', unvan: UNVAN_A, vergiDairesi: 'Tınaztepe', vergiNo: VKN_A };
    const siparis = (x = {}) => ({ kalemler: [{ urunId: p2.id, adet: 2, fiyat: 1 }, { urunId: p1.id, adet: 1 }], teslimat, fatura: faturaA,
        kosullarKabul: true, ticariBeyan: true, kosullarSurum: h.d.kosullar.surum, odemeYontemi: 'HAVALE', ...x });
    ok('ticari amac beyani onaylanmadan 400 TICARI_BEYAN', (d = await MA_('/siparisler', { body: siparis({ ticariBeyan: false }) })).status === 400 && d.d.code === 'TICARI_BEYAN', d);
    ok('kosullar onaylanmadan 400', (d = await MA_('/siparisler', { body: siparis({ kosullarKabul: false }) })).status === 400 && d.d.code === 'KOSULLAR', d);
    ok('eski kosul surumu 409 KOSULLAR_DEGISTI', (d = await MA_('/siparisler', { body: siparis({ kosullarSurum: 'eski' }) })).status === 409 && d.d.code === 'KOSULLAR_DEGISTI' && !!d.d.kosullar, d);
    ok('kart odemesi henuz yok: 400', (await MA_('/siparisler', { body: siparis({ odemeYontemi: 'KART' }) })).status === 400);
    ok('odeme yontemi constructor: 400', (await MA_('/siparisler', { body: siparis({ odemeYontemi: 'constructor' }) })).status === 400);
    ok('gecersiz TC kimlik no 400', (await MA_('/siparisler', { body: siparis({ fatura: { tip: 'SAHIS', unvan: 'Ali Veli', tcKimlikNo: '10000000147' } }) })).status === 400);
    ok('9 haneli vergi no 400', (await MA_('/siparisler', { body: siparis({ fatura: { ...faturaA, vergiNo: '123456789' } }) })).status === 400);
    ok('vergi dairesi yok 400', (await MA_('/siparisler', { body: siparis({ fatura: { ...faturaA, vergiDairesi: '' } }) })).status === 400);
    ok('fatura turu yok 400', (await MA_('/siparisler', { body: siparis({ fatura: { unvan: 'X' } }) })).status === 400);
    ok('kisa telefon 400', (await MA_('/siparisler', { body: siparis({ teslimat: { ...teslimat, telefon: '12345' } }) })).status === 400);
    ok('kisa adres 400', (await MA_('/siparisler', { body: siparis({ teslimat: { ...teslimat, adres: 'Afyon' } }) })).status === 400);
    ok('beklenen toplam tutmazsa 409 TUTAR_DEGISTI', (d = await MA_('/siparisler', { body: siparis({ beklenenToplamKurus: 1 }) })).status === 409
        && d.d.code === 'TUTAR_DEGISTI' && d.d.genelToplamKurus === 1207999, d);
    await query("UPDATE sistem_ayarlari SET deger = '' WHERE anahtar = 'iban'");
    ok('IBAN tanimsizken 409 ODEME_BILGISI_YOK', (d = await MA_('/siparisler', { body: siparis() })).status === 409 && d.d.code === 'ODEME_BILGISI_YOK', d);
    await query("UPDATE sistem_ayarlari SET deger = 'TR00 0000 0000 0000 0000 0000 00' WHERE anahtar = 'iban'");
    ok('hatali denemeler stoga dokunmadi (5)', (await R('/urunler')).d.urunler.find(x => x.id === p2.id).stokAdedi === 5);
    const o1r = await MA_('/siparisler', { body: siparis({ beklenenToplamKurus: 1207999, not: 'Kurulum desteği rica ederiz.' }) });
    const O1 = o1r.d;
    ok('siparis 201: ODEME_BEKLENIYOR, MG- no, sunucu tutari', o1r.status === 201 && O1.durum === 'ODEME_BEKLENIYOR' && /^MG-\d+$/.test(O1.noMetin)
        && O1.araToplamKurus === 1006666 && O1.kdvKurus === 201333 && O1.kargoKurus === 0 && O1.genelToplamKurus === 1207999, o1r.d);
    ok('kalem kopyalari: urun adi, birim fiyat, KDV', O1.kalemler && O1.kalemler.length === 2 && O1.kalemler[0].ad === ONEK + 'Termal Rulo'
        && O1.kalemler[0].birimKurus === 3333 && O1.kalemler[0].kdvOrani === 20 && O1.kalemler[0].toplamKurus === 7999, O1.kalemler);
    ok('odeme bilgisi: IBAN + tutar + aciklama siparis no', O1.odeme && O1.odeme.iban.startsWith('TR00') && O1.odeme.odemeAciklamasi === O1.noMetin, O1.odeme);
    ok('isletme yanitinda fatura bilgisi YOK', !('fatura' in O1) && !JSON.stringify(O1).includes(VKN_A) && !JSON.stringify(O1).includes(UNVAN_A), Object.keys(O1));
    ok('odeme bildirilmemis sipariste otomatik iptal tarihi (varsayilan 7 gun)', !!O1.otomatikIptal && O1.otomatikIptal.gun === 7, O1.otomatikIptal);
    ok('kabul ani + surum + metin kopyasi kaydedildi', !!O1.kosullar.kabulAt && O1.kosullar.surum === h.d.kosullar.surum && O1.kosullar.metin === h.d.kosullar.metin, O1.kosullar);
    ok('stok ayrildi: 5 -> 3', (await R('/urunler')).d.urunler.find(x => x.id === p2.id).stokAdedi === 3);
    const olay1 = await bekle(async () => (await query("SELECT * FROM root_olaylar WHERE tur = 'magaza_siparis' AND ref = ?", [O1.id])).rows[0]);
    ok('root_olaylar: magaza_siparis yazildi', !!olay1 && olay1.tenant_id === A.id && olay1.baslik === AD_A && olay1.detay.startsWith('Mağaza siparişi ' + O1.noMetin), olay1);
    const hz2 = await MA_('/hazirlik');
    ok('sonraki hazirlik teslimati son siparisten alir', hz2.d.teslimat.alici === 'Ahmet Yılmaz', hz2.d.teslimat);

    console.log('\n=== 8) Stok ayirma ve iade ===');
    ok('eldekinden fazla (4 > 3) siparis 409', (d = await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p2.id, adet: 4 }] }) })).status === 409 && d.d.code === 'SEPET_DEGISTI', d);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p2.id, adet: 4 }] } });
    ok('sepet ekrani fazla adedi stoga indirir + uyarir', s.d.kalemler[0].adet === 3 && s.d.sorunlar[0].sebep === 'STOK_YETERSIZ' && s.d.sorunlar[0].maksAdet === 3, s.d);
    const hB = await MB('/hazirlik');
    const sipB = (x = {}) => ({ kalemler: [{ urunId: p2.id, adet: 3 }], teslimat, fatura: { tip: 'SAHIS', unvan: 'Veli Kaya', tcKimlikNo: TCKN },
        kosullarKabul: true, ticariBeyan: true, kosullarSurum: hB.d.kosullar.surum, ...x });
    const o2r = await MB('/siparisler', { body: sipB() });
    const O2 = o2r.d;
    ok('deneme hesabi (B) de siparis verebilir; sahis faturasi TC ile', o2r.status === 201 && O2.genelToplamKurus === 26999, o2r.d);
    ok('deneme isletmede ikinci acik siparis 409 ACIK_SIPARIS_SINIRI', (d = await MB('/siparisler', { body: sipB({ kalemler: [{ urunId: p4.id, adet: 1 }] }) })).status === 409
        && d.d.code === 'ACIK_SIPARIS_SINIRI' && /Deneme sürümünde/.test(d.d.message), d);
    ok('stok 0 -> isletme listesinde kendiliginden Tukendi', (await MA_('/urunler')).d.urunler.find(x => x.id === p2.id).stok.durum === 'TUKENDI');
    const p2r = (await R('/urunler')).d.urunler.find(x => x.id === p2.id);
    ok('root listesinde stok 0 + etkin TUKENDI', p2r.stokAdedi === 0 && p2r.etkinStok === 'TUKENDI', p2r);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p2.id, adet: 1 }] } });
    ok('tukenen urun sepete girmez', s.d.kalemler.length === 0 && s.d.sorunlar[0].sebep === 'TUKENDI', s.d);
    d = await MB('/siparisler/' + O2.id + '/iptal', { body: { sebep: 'Yanlış adet' } });
    ok('B iptal etti (ODEME_BEKLENIYOR) -> IPTAL', d.status === 200 && d.d.durum === 'IPTAL' && d.d.kapatan === 'ISLETME' && d.d.kapanisSebebi === 'Yanlış adet', d.d);
    ok('iptalde stok geri dondu: 0 -> 3', (await R('/urunler')).d.urunler.find(x => x.id === p2.id).stokAdedi === 3);
    const olayIptal = await bekle(async () => (await query("SELECT * FROM root_olaylar WHERE tur = 'magaza_iptal' AND ref = ?", [O2.id])).rows[0]);
    ok('isletme iptali Patron\'a bildirim (root_olaylar magaza_iptal)', !!olayIptal && olayIptal.detay.includes('işletme tarafından iptal edildi'), olayIptal);
    ok('iptalden sonra deneme isletme yeniden siparis verebilir (limit serbest)', (await MB('/sepet', { body: { kalemler: [{ urunId: p4.id, adet: 1 }] } })).status === 200);
    ok('urun yeniden Stokta', (await MA_('/urunler')).d.urunler.find(x => x.id === p2.id).stok.durum === 'STOKTA');
    ok('iptal edilmis siparis tekrar iptal edilemez 409', (await MB('/siparisler/' + O2.id + '/iptal', { body: {} })).status === 409);
    const O3 = (await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p2.id, adet: 1 }] }) })).d;
    ok('O3 stok 3 -> 2', (await R('/urunler')).d.urunler.find(x => x.id === p2.id).stokAdedi === 2);
    ok('red sebepsiz 400', (d = await R('/siparisler/' + O3.id + '/durum', { body: { durum: 'REDDEDILDI' } })).status === 400 && d.d.code === 'SEBEP', d);
    d = await R('/siparisler/' + O3.id + '/durum', { body: { durum: 'REDDEDILDI', sebep: 'Ödeme 3 gün içinde ulaşmadı.' } });
    ok('root reddetti -> REDDEDILDI', d.status === 200 && d.d.durum === 'REDDEDILDI' && d.d.kapatan === 'ROOT', d.d);
    ok('redde stok geri dondu: 2 -> 3', (await R('/urunler')).d.urunler.find(x => x.id === p2.id).stokAdedi === 3);
    d = await MA_('/siparisler/' + O3.id);
    ok('isletme red sebebini gorur', d.d.durum === 'REDDEDILDI' && d.d.kapanisSebebi === 'Ödeme 3 gün içinde ulaşmadı.' && !d.d.odeme, d.d);

    console.log('\n=== 9) Isletme izolasyonu ===');
    ok('B, A siparisini goremez 404', (await MB('/siparisler/' + O1.id)).status === 404);
    ok('B, A siparisine odeme bildiremez 404', (await MB('/siparisler/' + O1.id + '/odeme-bildir', { body: {} })).status === 404);
    ok('B, A siparisini iptal edemez 404', (await MB('/siparisler/' + O1.id + '/iptal', { body: {} })).status === 404);
    d = await MB('/siparisler');
    ok('B listesinde yalniz kendi siparisi', d.d.length === 1 && d.d[0].id === O2.id, d.d.map(x => x.id));
    d = await M(MUDUR)('/siparisler');
    ok('A muduru A siparislerini gorur', d.d.some(x => x.id === O1.id), d.d.length);

    console.log('\n=== 10) "Odemeyi yaptim" + bildirim ===');
    d = await MA_('/siparisler/' + O1.id + '/odeme-bildir', { body: { referans: 'DEKONT-77' } });
    ok('odeme bildirildi 200', d.status === 200 && !!d.d.odemeBildirildiAt && d.d.odemeReferans === 'DEKONT-77' && d.d.durum === 'ODEME_BEKLENIYOR', d.d);
    ok('odeme bildirildikten sonra otomatik iptal tarihi yok', !d.d.otomatikIptal, d.d.otomatikIptal);
    const odemeSonrasiIptal = await MA_('/siparisler/' + O1.id + '/iptal', { body: {} });
    ok('odeme bildirildikten sonra isletme iptal edemez (409 ODEME_BILDIRILDI)', odemeSonrasiIptal.status === 409 && odemeSonrasiIptal.d.code === 'ODEME_BILDIRILDI'
        && odemeSonrasiIptal.d.message.includes('MDA Yazılım ile iletişime geçin'), odemeSonrasiIptal);
    ok('ikinci bildirim 409', (d = await MA_('/siparisler/' + O1.id + '/odeme-bildir', { body: {} })).status === 409 && d.d.code === 'ZATEN_BILDIRILDI', d);
    const olay2 = await bekle(async () => (await query("SELECT * FROM root_olaylar WHERE tur = 'magaza_odeme' AND ref = ?", [O1.id])).rows[0]);
    ok('root_olaylar: magaza_odeme yazildi', !!olay2 && olay2.detay.startsWith('Mağaza ödemesi bildirildi'), olay2);
    d = await js('/api/root/cihaz/bildirim-durumu', { body: { bildirimJetonu: BJ, olaySonId: S0 } });
    ok('bildirim-durumu yanitinda gorunur: son olay magaza_odeme', d.status === 200 && d.d.olay && d.d.olay.yeni >= 2
        && d.d.olay.son.tur === 'magaza_odeme' && d.d.olay.son.isletme === AD_A, d.d.olay);
    let oz = await R('/ozet');
    ok('root ozet: islem bekleyen + odeme bildirilen sayisi', oz.status === 200 && oz.d.islemBekleyen >= 1 && oz.d.odemeBildirilen >= 1, oz.d);
    let rs = await R('/siparisler?filtre=bekleyen');
    ok('root liste filtresi bekleyen: O1 var, iptal edilmis O2 yok', rs.d.siparisler.some(x => x.id === O1.id) && !rs.d.siparisler.some(x => x.id === O2.id)
        && rs.d.sayilar.bekleyen >= 1 && rs.d.sayilar.iptal >= 2, rs.d.sayilar);
    ok('bilinmeyen filtre (constructor) 200 + hepsi', (d = await R('/siparisler?filtre=constructor')).status === 200 && Array.isArray(d.d.siparisler), d.status);
    rs = await R('/siparisler?filtre=iptal');
    ok('root liste filtresi iptal: O2 + O3', rs.d.siparisler.some(x => x.id === O2.id) && rs.d.siparisler.some(x => x.id === O3.id), rs.d.siparisler.length);

    console.log('\n=== 11) Durum gecisleri + gecersiz gecisler ===');
    const D = (id, govde) => R('/siparisler/' + id + '/durum', { body: govde });
    ok('odeme alinmadan HAZIRLANIYOR 409', (d = await D(O1.id, { durum: 'HAZIRLANIYOR' })).status === 409 && d.d.code === 'GECERSIZ_GECIS', d);
    ok('odeme alinmadan KARGODA 409', (await D(O1.id, { durum: 'KARGODA', kargoFirma: 'Aras Kargo', kargoTakipNo: '123456' })).status === 409);
    ok('odeme alinmadan TESLIM 409', (await D(O1.id, { durum: 'TESLIM_EDILDI' })).status === 409);
    ok('root IPTAL hedefi kullanamaz (red kullanir) 400', (await D(O1.id, { durum: 'IPTAL' })).status === 400);
    ok('bilinmeyen hedef 400', (await D(O1.id, { durum: 'UCTU' })).status === 400);
    d = await D(O1.id, { durum: 'ODEME_ALINDI' });
    ok('ODEME_ALINDI 200', d.status === 200 && d.d.durum === 'ODEME_ALINDI' && !!d.d.odemeAlindiAt, d.d);
    ok('isletme artik iptal edemez 409', (d = await MA_('/siparisler/' + O1.id + '/iptal', { body: {} })).status === 409 && d.d.code === 'GECERSIZ_DURUM', d);
    ok('isletme artik odeme bildiremez 409', (await MA_('/siparisler/' + O1.id + '/odeme-bildir', { body: {} })).status === 409);
    ok('ODEME_ALINDI ikinci kez 409', (await D(O1.id, { durum: 'ODEME_ALINDI' })).status === 409);
    ok('HAZIRLANIYOR 200', (d = await D(O1.id, { durum: 'HAZIRLANIYOR' })).status === 200 && d.d.durum === 'HAZIRLANIYOR');
    ok('kargo bilgisiz KARGODA 400', (d = await D(O1.id, { durum: 'KARGODA', kargoFirma: 'Yurtiçi Kargo' })).status === 400 && d.d.code === 'KARGO_BILGISI', d);
    d = await D(O1.id, { durum: 'KARGODA', kargoFirma: 'Yurtiçi Kargo', kargoTakipNo: '900123456789' });
    ok('KARGODA 200 + firma + takip no', d.status === 200 && d.d.durum === 'KARGODA' && d.d.kargoFirma === 'Yurtiçi Kargo' && d.d.kargoTakipNo === '900123456789', d.d);
    ok('kargodaki siparis reddedilemez 409', (await D(O1.id, { durum: 'REDDEDILDI', sebep: 'Geç kaldı' })).status === 409);
    d = await R('/siparisler/' + O1.id, { method: 'PATCH', body: { kargoTakipNo: '900123456780' } });
    ok('kargo takip no duzeltildi', d.status === 200 && d.d.kargoTakipNo === '900123456780', d.d);
    ok('TESLIM_EDILDI 200', (d = await D(O1.id, { durum: 'TESLIM_EDILDI' })).status === 200 && d.d.durum === 'TESLIM_EDILDI' && !!d.d.teslimAt);
    ok('teslimden sonra hicbir gecis yok 409', (await D(O1.id, { durum: 'KARGODA', kargoFirma: 'Aras Kargo', kargoTakipNo: '1234' })).status === 409
        && (await D(O1.id, { durum: 'REDDEDILDI', sebep: 'Deneme' })).status === 409);
    ok('olmayan siparis 404', (await D('yok-boyle', { durum: 'ODEME_ALINDI' })).status === 404);
    d = await MA_('/siparisler/' + O1.id);
    const olaylar = d.d.gecmis.map(x => x.olay);
    ok('isletme cizelgesi: olusturma, odeme bildirimi, 4 durum + kargo duzeltmesi', ['ODEME_BEKLENIYOR', 'ODEME_BILDIRIMI', 'ODEME_ALINDI', 'HAZIRLANIYOR', 'KARGODA', 'TESLIM_EDILDI']
        .every(x => olaylar.includes(x)), olaylar);
    const O4 = (await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p4.id, adet: 1 }] }) })).d;
    await D(O4.id, { durum: 'ODEME_ALINDI' });
    d = await D(O4.id, { durum: 'KARGODA', kargoFirma: 'Aras Kargo', kargoTakipNo: 'AR998877' });
    ok('stoktaki urun: ODEME_ALINDI -> KARGODA (hazirlaniyor atlanabilir)', d.status === 200 && d.d.durum === 'KARGODA', d.d);
    ok('kargo duzeltmesi yalniz kargodaki/teslim sipariste (redde 409)', (await R('/siparisler/' + O3.id, { method: 'PATCH', body: { kargoFirma: 'X Kargo', kargoTakipNo: '12345' } })).status === 409);

    console.log('\n=== 12) Root: ic not + fatura isareti; fatura bilgisi yalniz root\'ta ===');
    d = await R('/siparisler/' + O1.id, { method: 'PATCH', body: { icNot: 'Kurulumu Pazartesi yapılacak.', faturaKesildi: true, faturaNo: 'GIB2026000000001' } });
    ok('ic not + fatura kesildi + fatura no', d.status === 200 && d.d.icNot === 'Kurulumu Pazartesi yapılacak.' && !!d.d.faturaKesildiAt && d.d.faturaNo === 'GIB2026000000001', d.d);
    ok('root ayrintisinda fatura bilgisi (unvan, vergi dairesi, vergi no)', d.d.fatura.unvan === UNVAN_A && d.d.fatura.vergiNo === VKN_A
        && d.d.fatura.vergiDairesi === 'Tınaztepe' && d.d.fatura.adres === teslimat.adres, d.d.fatura);
    ok('root ayrintisi: isletme, KDV dagilimi, kargo ayrimi', d.d.isletme.ad === AD_A && d.d.isletme.kod === A.kod && d.d.kdvDagilimi.length === 1
        && d.d.kdvDagilimi[0].kdvKurus === 201333 && d.d.kargoAyrimi.haricKurus === 0, d.d.isletme);
    d = await MA_('/siparisler/' + O1.id);
    ok('isletme ayrintisi: ic not YOK, fatura bilgisi YOK, fatura no var', !('icNot' in d.d) && !('fatura' in d.d) && !JSON.stringify(d.d).includes(VKN_A)
        && !JSON.stringify(d.d).includes(UNVAN_A) && d.d.faturaNo === 'GIB2026000000001' && !JSON.stringify(d.d).includes('Pazartesi'), Object.keys(d.d));
    d = await MA_('/siparisler');
    ok('isletme listesinde de fatura bilgisi yok', !JSON.stringify(d.d).includes(VKN_A));
    d = await R('/siparisler/' + O2.id);
    ok('sahis faturasi: TC root\'ta gorunur', d.d.fatura.tip === 'SAHIS' && d.d.fatura.tcKimlikNo === TCKN, d.d.fatura);
    d = await MB('/siparisler/' + O2.id);
    ok('sahis faturasi: TC isletmeye donmez', !JSON.stringify(d.d).includes(TCKN));
    d = await R('/siparisler/' + O1.id, { method: 'PATCH', body: { faturaKesildi: false } });
    ok('fatura isareti kaldirilabilir', d.d.faturaKesildiAt === null && d.d.faturaNo === null, d.d);
    ok('reddedilmis siparise fatura isareti 409 FATURA_DURUM', (d = await R('/siparisler/' + O3.id, { method: 'PATCH', body: { faturaKesildi: true, faturaNo: 'X1' } })).status === 409 && d.d.code === 'FATURA_DURUM', d);
    ok('reddedilmis siparise yalniz fatura no da 409', (await R('/siparisler/' + O3.id, { method: 'PATCH', body: { faturaNo: 'X2' } })).status === 409);
    ok('iptal edilmis siparise fatura isareti 409', (await R('/siparisler/' + O2.id, { method: 'PATCH', body: { faturaKesildi: true } })).status === 409);
    ok('odemesi alinmamis reddedilmis sipariste iade 409 IADE_DURUM', (d = await R('/siparisler/' + O3.id, { method: 'PATCH', body: { iadeYapildi: true } })).status === 409 && d.d.code === 'IADE_DURUM', d);
    ok('teslim edilmis sipariste iade 409', (await R('/siparisler/' + O1.id, { method: 'PATCH', body: { iadeYapildi: true } })).status === 409);
    const O5 = (await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p4.id, adet: 1 }] }) })).d;
    await R('/siparisler/' + O5.id + '/durum', { body: { durum: 'ODEME_ALINDI' } });
    await R('/siparisler/' + O5.id + '/durum', { body: { durum: 'REDDEDILDI', sebep: 'Ürün tedarik edilemedi, ödemeniz iade edilecek.' } });
    const listeIade = async (sid) => ((await R('/siparisler?filtre=iptal')).d.siparisler.find(x => x.id === sid) || {}).iade;
    ok('root listesi: odemesi alinmis red -> iade BEKLIYOR, odemesiz red -> null',
        (await listeIade(O5.id)) === 'BEKLIYOR' && (await listeIade(O3.id)) === null);
    ok('gecersiz iade tarihi 400', (await R('/siparisler/' + O5.id, { method: 'PATCH', body: { iadeYapildi: true, iadeTarihi: '2026-13-40' } })).status === 400);
    d = await R('/siparisler/' + O5.id, { method: 'PATCH', body: { iadeYapildi: true, iadeTarihi: '2026-11-12', iadeNotu: 'EFT dekont 998877' } });
    ok('iade yapildi (tarih + not) + gecmis', d.status === 200 && d.d.iade && d.d.iade.tarih === '2026-11-12' && d.d.iade.not === 'EFT dekont 998877'
        && d.d.gecmis.some(x => x.olay === 'IADE'), d.d.iade);
    ok('root listesi: iade YAPILDI', (await listeIade(O5.id)) === 'YAPILDI');
    d = await MA_('/siparisler/' + O5.id);
    ok('isletme iade tarihini gorur, notu gormez', !!d.d.iade && d.d.iade.tarih === '2026-11-12' && !JSON.stringify(d.d).includes('998877'), d.d.iade);
    ok('iade isareti kaldirilabilir', (await R('/siparisler/' + O5.id, { method: 'PATCH', body: { iadeYapildi: false } })).d.iade === null);
    ok('bos PATCH 400', (await R('/siparisler/' + O1.id, { method: 'PATCH', body: {} })).status === 400);

    console.log('\n=== 13) Yumusak silme: siparisteki urun silinir, siparis kopyasi kalir ===');
    await R('/urunler/' + p2.id, { method: 'PUT', body: { fiyat: 50, ad: ONEK + 'Termal Rulo 80mm' } });
    d = await R('/urunler/' + p1.id, { method: 'DELETE' });
    ok('sipariste gecen urun yumusak silindi', d.status === 200 && d.d.yumusak === true, d.d);
    ok('root listesinden kalkti', !(await R('/urunler')).d.urunler.some(x => x.id === p1.id));
    ok('isletme listesinden kalkti + ayrinti 404', !(await MA_('/urunler')).d.urunler.some(x => x.id === p1.id) && (await MA_('/urunler/' + p1.id)).status === 404);
    ok('satir veritabaninda duruyor (silindi_at dolu)', !!(await query('SELECT silindi_at FROM magaza_urunler WHERE id = ?', [p1.id])).rows[0].silindi_at);
    d = await MA_('/siparisler/' + O1.id);
    const kp1 = d.d.kalemler.find(x => x.urunId === p1.id), kp2 = d.d.kalemler.find(x => x.urunId === p2.id);
    ok('siparis kopyasi: silinen urunun adi + fiyati duruyor', kp1 && kp1.ad === ONEK + 'Dokunmatik POS' && kp1.birimKurus === 1000000 && kp1.kdvKurus === 200000, kp1);
    ok('siparis kopyasi: sonradan degisen urunun eski adi + fiyati', kp2 && kp2.ad === ONEK + 'Termal Rulo' && kp2.birimKurus === 3333, kp2);
    ok('silinen urun tekrar silinemez 404', (await R('/urunler/' + p1.id, { method: 'DELETE' })).status === 404);
    ok('silinen urun guncellenemez 404', (await R('/urunler/' + p1.id, { method: 'PUT', body: { ad: 'Geri Gel' } })).status === 404);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p1.id, adet: 1 }] } });
    ok('silinen urun sepete girmez', s.d.kalemler.length === 0 && s.d.sorunlar[0].sebep === 'SATISTA_DEGIL');

    console.log('\n=== 14) Resim turu ve boyut denetimi ===');
    const RS = (urunId, veri) => R('/urunler/' + urunId + '/resimler', { body: veri === undefined ? {} : { veri } });
    let rr = await RS(p4.id, PNG1);
    ok('PNG 201 + ilk resim kapak', rr.status === 201 && rr.d.resimler.length === 1 && rr.d.resimler[0].kapak === true && /^\/uploads\/magaza\/[^/]+\.png$/.test(rr.d.resimler[0].yol), rr.d.resimler);
    const resim1 = rr.d.resimler[0];
    ok('dosya diske yazildi', dosyaVar(resim1.yol));
    const gr = await fetch(TABAN + resim1.yol);
    ok('dosya sunuluyor (200, image/png, nosniff)', gr.status === 200 && /image\/png/.test(gr.headers.get('content-type') || '') && gr.headers.get('x-content-type-options') === 'nosniff');
    rr = await RS(p4.id, JPG1);
    ok('JPEG 201', rr.status === 201 && rr.d.resimler.length === 2 && /\.jpg$/.test(rr.d.resimler[1].yol));
    rr = await RS(p4.id, WEBP1);
    ok('WebP 201', rr.status === 201 && rr.d.resimler.length === 3 && /\.webp$/.test(rr.d.resimler[2].yol));
    ok('SVG 400', (d = await RS(p4.id, 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=')).status === 400 && d.d.code === 'RESIM_TUR', d);
    ok('GIF 400', (await RS(p4.id, 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')).status === 400);
    ok('PNG diye gonderilen JPEG icerigi 400 (tur/icerik uyusmazligi)', (await RS(p4.id, 'data:image/png;base64,' + JPG1.split(',')[1])).status === 400);
    ok('PNG diye gonderilen HTML 400', (await RS(p4.id, 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64'))).status === 400);
    ok('http adresi 400', (await RS(p4.id, 'https://kotu.example/a.png')).status === 400);
    ok('veri yok 400', (await RS(p4.id)).status === 400);
    ok('2 MB + 1 bayt 413', (d = await RS(p4.id, pngBoyut(2 * 1024 * 1024 + 1))).status === 413 && d.d.code === 'RESIM_BOYUT', [d.status, d.d && d.d.code]);
    rr = await RS(p4.id, pngBoyut(2 * 1024 * 1024));
    ok('tam 2 MB kabul', rr.status === 201 && rr.d.resimler.length === 4, rr.status);
    ok('olmayan urune resim 404', (await RS('yok-boyle', PNG1)).status === 404);
    const ids4 = rr.d.resimler.map(x => x.id);
    rr = await R('/urunler/' + p4.id + '/resimler/' + ids4[1] + '/kapak', { body: {} });
    ok('kapak degisti (tek kapak)', rr.status === 200 && rr.d.resimler.filter(x => x.kapak).length === 1 && rr.d.resimler.find(x => x.kapak).id === ids4[1], rr.d.resimler);
    ud = await MA_('/urunler/' + p4.id);
    ok('isletme galerisi kapakla baslar', ud.d.resimler[0].id === ids4[1] && ud.d.kapak === rr.d.kapak, ud.d.resimler.map(x => x.id));
    rr = await R('/urunler/' + p4.id + '/resimler/sirala', { body: { sira: [...ids4].reverse() } });
    ok('resim sirasi degisti', rr.status === 200 && rr.d.resimler.map(x => x.id).join() === [...ids4].reverse().join(), rr.d.resimler.map(x => x.id));
    const kapakYol = rr.d.resimler.find(x => x.kapak).yol;
    rr = await R('/urunler/' + p4.id + '/resimler/' + ids4[1], { method: 'DELETE' });
    ok('kapak silinince siradaki ilk resim kapak olur', rr.status === 200 && rr.d.resimler.length === 3 && rr.d.resimler[0].kapak === true, rr.d.resimler);
    ok('silinen resmin dosyasi silindi', !dosyaVar(kapakYol));
    rr = await RS(p3.id, PNG1);
    const p3Yol = rr.d.resimler[0].yol;
    for (let i = 0; i < 11; i++) await RS(p3.id, PNG1);
    ok('resim siniri: 13. resim 409', (await RS(p3.id, PNG1)).status === 409);
    d = await R('/urunler/' + p3.id, { method: 'DELETE' });
    ok('siparise girmemis urun tamamen silinir + dosyalari', d.d.yumusak === false && !(await query('SELECT 1 FROM magaza_urunler WHERE id = ?', [p3.id])).rows.length
        && !(await query('SELECT 1 FROM magaza_urun_resimleri WHERE urun_id = ?', [p3.id])).rows.length && !dosyaVar(p3Yol), d.d);

    console.log('\n=== 15) Urun siralama ===');
    const benim = (await R('/urunler')).d.urunler.filter(x => x.ad.startsWith(ONEK)).map(x => x.id);
    d = await R('/urunler/sirala', { body: { sira: [...benim].reverse() } });
    const yeniSira = d.d.urunler.filter(x => x.ad.startsWith(ONEK)).map(x => x.id);
    ok('siralama uygulandi', d.status === 200 && yeniSira.join() === [...benim].reverse().join(), yeniSira);
    const isletmeSira = (await MA_('/urunler')).d.urunler.map(x => x.id).filter(x => benim.includes(x));
    ok('isletme listesi ayni sirada', isletmeSira.length >= 3 && isletmeSira.join() === yeniSira.filter(x => isletmeSira.includes(x)).join(), [isletmeSira, yeniSira]);
    ok('gecersiz sira listesi 400', (await R('/urunler/sirala', { body: { sira: 'x' } })).status === 400);

    console.log('\n=== 16) Satis kosullari surumu + ayar denetimi ===');
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'magaza_otomatik_iptal_gun'");
    ok('otomatik iptal suresi varsayilan 7', (await R('/ayarlar')).d.otomatikIptalGun === 7);
    ok('otomatik iptal suresi 400 (366)', (await R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: 366 } })).status === 400);
    ok('otomatik iptal suresi 0 = kapali kabul', (await R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: 0 } })).d.otomatikIptalGun === 0);
    await R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: 7 } });
    ok('gecersiz kargo ucreti 400', (await R('/ayarlar', { method: 'PUT', body: { kargoUcret: 'abc' } })).status === 400);
    ok('gecersiz bildirim e-postasi 400', (await R('/ayarlar', { method: 'PUT', body: { bildirimEposta: 'eposta-degil' } })).status === 400);
    a = await R('/ayarlar', { method: 'PUT', body: { satisKosullari: 'Özel satış koşulları metni.\n\n1. Madde' } });
    ok('kosullar degisti, surum degisti', a.status === 200 && a.d.kosullarVarsayilan === false && a.d.kosullarSurum !== h.d.kosullar.surum, a.d.kosullarSurum);
    ok('eski surumle siparis 409', (d = await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p4.id, adet: 1 }] }) })).status === 409 && d.d.code === 'KOSULLAR_DEGISTI'
        && d.d.kosullar.surum === a.d.kosullarSurum, d);
    a = await R('/ayarlar', { method: 'PUT', body: { satisKosullari: '' } });
    ok('bos metin -> varsayilan metne doner', a.d.kosullarVarsayilan === true && a.d.kosullarSurum === h.d.kosullar.surum, a.d);
    ok('root: ham metin jetonlu, onizleme satici bloguyla ve jetonsuz', a.d.satisKosullari.includes('{{OTOMATIK_IPTAL}}') && a.d.kosullarOnizleme.startsWith('Satıcı bilgileri')
        && !a.d.kosullarOnizleme.includes('{{'), a.d.kosullarOnizleme && a.d.kosullarOnizleme.slice(0, 120));
    a = await R('/ayarlar', { method: 'PUT', body: { satici: { unvan: SATICI.unvan + ' A.Ş.' } } });
    ok('satici bilgisi degisince kosul surumu degisir', a.d.kosullarSurum !== h.d.kosullar.surum);
    a = await R('/ayarlar', { method: 'PUT', body: { satici: { unvan: SATICI.unvan } } });
    ok('acikken satici alani bosaltilamaz (409)', (await R('/ayarlar', { method: 'PUT', body: { satici: { telefon: '' } } })).status === 409);
    ok('acik: "false" yazisi kapali sayilir', (await R('/ayarlar', { method: 'PUT', body: { acik: 'false' } })).d.acikAyar === false);
    ok('acik: "evet" kapali sayilir', (await R('/ayarlar', { method: 'PUT', body: { acik: 'evet' } })).d.acikAyar === false);
    ok('acik: 1 acik sayilir', (await R('/ayarlar', { method: 'PUT', body: { acik: 1 } })).d.acik === true);
    ok('surum eski haline dondu', (await R('/ayarlar')).d.kosullarSurum === h.d.kosullar.surum);
    ok('ayar yaniti: odeme bilgisi salt okunur doner', a.d.odeme && a.d.odeme.iban.startsWith('TR00'));

    console.log('\n=== 17) Acik siparis siniri (lisansli isletme: ayni anda 5 odemesi beklenen) ===');
    await lisansla(Bi.id);
    const hB2 = await MB('/hazirlik');
    let son;
    for (let i = 0; i < 6; i++) son = await MB('/siparisler', { body: sipB({ kalemler: [{ urunId: p4.id, adet: 1 }], kosullarSurum: hB2.d.kosullar.surum }) });
    ok('6. siparis 409 ACIK_SIPARIS_SINIRI', son.status === 409 && son.d.code === 'ACIK_SIPARIS_SINIRI', son);
    d = await MB('/durum');
    ok('durum: aktif siparis sayisi 5', d.d.aktifSiparis === 5, d.d);
    await R('/ayarlar', { method: 'PUT', body: { acik: false } });
    d = await MB('/durum');
    ok('magaza kapali ama aktif siparisi olan isletme menude gorebilir (acik=false, aktif=5)', d.d.acik === false && d.d.aktifSiparis === 5, d.d);
    const bekleyenlerB = (await MB('/siparisler')).d.filter(x => x.durum === 'ODEME_BEKLENIYOR');
    ok('magaza kapaliyken odeme bildirimi calisir', (await MB('/siparisler/' + bekleyenlerB[0].id + '/odeme-bildir', { body: {} })).status === 200);
    ok('magaza kapaliyken iptal calisir (odeme bildirilmemis siparis)', (await MB('/siparisler/' + bekleyenlerB[1].id + '/iptal', { body: {} })).status === 200);
    ok('odeme bildirilmis siparis iptal edilemez', (await MB('/siparisler/' + bekleyenlerB[0].id + '/iptal', { body: {} })).status === 409);
    await R('/ayarlar', { method: 'PUT', body: { acik: true } });

    console.log('\n=== 18) Yonetici sifresi (Lisans sayfasiyla ayni kilit) ===');
    ok('sifre belirlendi', (await js('/api/auth/manager-set', { token: Bi.token, body: { pin: '246810' } })).status === 200);
    ok('sifresiz urun listesi 403 MANAGER_PIN_REQUIRED', (d = await MB('/urunler')).status === 403 && d.d.code === 'MANAGER_PIN_REQUIRED', d);
    ok('sifreli istek 200', (await MB('/urunler', { headers: { 'x-manager-pin': '246810' } })).status === 200);
    ok('/durum sifre istemez (menu cizilebilsin)', (await MB('/durum')).status === 200);

    console.log('\n=== 19) Stok kilidi, ayrilmis adet, cift gonderim, isletmeye gorunen stok ===');
    const p7 = (await R('/urunler', { body: { ad: ONEK + 'Kagit 15', fiyat: 10, kdvOrani: 20, stokAdedi: 15, yayin: 'YAYINDA' } })).d;
    ul = await MA_('/urunler');
    let g7 = ul.d.urunler.find(x => x.id === p7.id);
    ok('10dan fazla stok: isletmeye "10+" ve en fazla 10 secim', g7.stok.adetMetni === '10+' && g7.maksAdet === 10 && !('stokAdedi' in g7), g7);
    ud = await MA_('/urunler/' + p7.id);
    ok('ayrintida da 10+ / 10', ud.d.stok.adetMetni === '10+' && ud.d.maksAdet === 10, ud.d.stok);
    s = await MA_('/sepet', { body: { kalemler: [{ urunId: p7.id, adet: 20 }] } });
    ok('fazla adet uyarisi kesin stogu sizdirmaz', s.d.sorunlar[0].sebep === 'STOK_YETERSIZ' && !/en fazla [0-9]+ adet/.test(s.d.sorunlar[0].mesaj) && s.d.sorunlar[0].mesaj.includes('stokta istenen kadar ürün yok') && s.d.sorunlar[0].maksAdet === 10, s.d.sorunlar);
    const anahtar = 'test-' + require('crypto').randomUUID();
    const ilk = await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p7.id, adet: 6 }], istekAnahtari: anahtar }) });
    const ikinci = await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p7.id, adet: 6 }], istekAnahtari: anahtar }) });
    ok('ayni istek anahtari: ilk 201, ikinci 200 ayni siparis (tekrar)', ilk.status === 201 && ikinci.status === 200 && ikinci.d.id === ilk.d.id && ikinci.d.tekrar === true, [ilk.status, ikinci.status, ikinci.d && ikinci.d.message]);
    ok('cift gonderimde stok bir kez dustu (15 -> 9)', (await R('/urunler')).d.urunler.find(x => x.id === p7.id).stokAdedi === 9);
    ok('baska isletme ayni anahtarla ayri siparis acar (anahtar isletme basina)', (d = await MB('/siparisler', { body: sipB({ kalemler: [{ urunId: p4.id, adet: 1 }], istekAnahtari: anahtar }), headers: { 'x-manager-pin': '246810' } })).status === 201 && d.d.id !== ilk.d.id, d.status);
    ok('gecersiz istek anahtari 400', (await MA_('/siparisler', { body: siparis({ kalemler: [{ urunId: p7.id, adet: 1 }], istekAnahtari: 'kısa!' }) })).status === 400);
    g7 = (await MA_('/urunler')).d.urunler.find(x => x.id === p7.id);
    ok('10 ve alti kesin gosterilir (9)', g7.stok.adetMetni === '9' && g7.maksAdet === 9, g7.stok);
    const r7 = (await R('/urunler')).d.urunler.find(x => x.id === p7.id);
    ok('root listesinde acik siparislerde ayrilmis adet (6)', r7.acikSiparisteAyrilan === 6, r7);
    ok('beklenen adet olmadan stok degisikligi 400 STOK_KILIDI', (d = await R('/urunler/' + p7.id, { method: 'PUT', body: { stokAdedi: 30 } })).status === 400 && d.d.code === 'STOK_KILIDI', d);
    d = await R('/urunler/' + p7.id, { method: 'PUT', body: { stokAdedi: 30, beklenenStokAdedi: 15, ad: ONEK + 'Kagit 15 yeni' } });
    ok('eski adetle kayit 409 STOK_DEGISTI + guncel adet; hicbir alan yazilmadi', d.status === 409 && d.d.code === 'STOK_DEGISTI' && d.d.stokAdedi === 9
        && d.d.message.includes('Bu arada sipariş geldi') && (await R('/urunler')).d.urunler.find(x => x.id === p7.id).ad === ONEK + 'Kagit 15', d);
    d = await R('/urunler/' + p7.id, { method: 'PUT', body: { stokAdedi: 30, beklenenStokAdedi: 9 } });
    ok('guncel adetle kayit 200', d.status === 200 && d.d.stokAdedi === 30, d.d);
    ok('stok degistirmeyen kayit beklenen adet istemez', (await R('/urunler/' + p7.id, { method: 'PUT', body: { kisaAciklama: 'Kısa' } })).status === 200);
    await MA_('/siparisler/' + ilk.d.id + '/iptal', { body: {} });
    ok('iptalde ayrilan adet geri doner (30 + 6)', (await R('/urunler')).d.urunler.find(x => x.id === p7.id).stokAdedi === 36);

    kapat();
    await uyu(400);
    await temizle();
    await ayarlariGeriYukle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => {
    console.error('COKTU:', e);
    try { await temizle(); await ayarlariGeriYukle(); } catch (_) {}
    process.exit(1);
});
