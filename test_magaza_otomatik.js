// MDA Yazilim Magazasi (2. tur): isletmeye e-posta (odeme alindi, kargoya verildi, reddedildi, otomatik iptal;
// sahte tasiyiciyla; gonderim hatasi akisi durdurmaz; alicisi gecersiz isletmede gonderim atlanir), odenmeyen
// siparisin otomatik iptali (sure ayari, 0 = kapali, odeme bildirilmisse iptal yok, stok iadesi, tekrar
// calistirmada cift iade yok, gecmis + sebep), lisansi salt-okunur moda dusmus isletmede magaza uclarinin acik
// olmasi (KAPALI lisansta kapali kalir).
// Sunucu AYNI SURECTE calisir (sahte e-posta tasiyicisi enjekte edilebilsin).  Calistir: node test_magaza_otomatik.js
const PORT = 45992, TABAN = `http://127.0.0.1:${PORT}`;
const ROOT_EPOSTA = 'rootmagaza2@ornek.test', ROOT_PAROLA = 'MagazaOtomatikParola123';
Object.assign(process.env, {
    PORT: String(PORT), JWT_SECRET: 'magaza-otomatik-test-jwt', ROOT_EMAIL: ROOT_EPOSTA, ROOT_PASSWORD: ROOT_PAROLA,
    HUB_URL: 'http://127.0.0.1:9', NODE_ENV: 'development', POS_PANEL_URL: 'http://panel.test',
});
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const fs = require('fs');
const path = require('path');
const { query } = require('./src/config/db');
const totp = require('./src/services/totp');
const L = require('./src/services/lisansDurumu');
const E = require('./src/services/magazaEposta');
const Z = require('./src/services/magazaZamanlayici');
const { UPLOADS_DIR } = require('./src/services/imageService');

const AD = { A: 'Magaza Oto Lokanta', B: 'Magaza Oto Kafe', C: 'Magaza Oto Pastane' };
const EPOSTA = { A: 'oto-a@ornek.test', B: 'oto-b@ornek.test', C: 'oto-c@ornek.test' };
const ONEK = 'MGOTO ';
const AYARLAR = ['magaza_acik', 'magaza_kargo_ucret_kurus', 'magaza_kargo_esik_kurus', 'magaza_satis_kosullari',
    'magaza_otomatik_iptal_gun', 'iban', 'iban_sahibi', 'banka_adi', 'odeme_aciklama', 'bildirim_eposta',
    'magaza_satici_unvan', 'magaza_satici_adres', 'magaza_satici_vergi_dairesi', 'magaza_satici_vkn', 'magaza_satici_telefon', 'magaza_satici_eposta'];
const SATICI = { unvan: 'MDA Yazılım Oto Test', adres: 'Örnek Mah. Test Cad. No 1, Merkez, Afyonkarahisar', vergiDairesi: 'Tınaztepe',
    vkn: '1234567890', telefon: '0272 000 00 00', eposta: 'oto-satici@ornek.test' };

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
async function bekle(kosul, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const r = await Promise.resolve().then(kosul).catch(() => null); if (r) return r; await uyu(100); }
    return null;
}
async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

// --- Sahte e-posta tasiyicisi + gunluk yakalama ---
const gelen = [];
let tasiyiciModu = 'ok';            // ok | firlat | basarisiz
E.tasiyiciAyarla({
    sendMail: async (m) => {
        if (tasiyiciModu === 'firlat') throw new Error('SMTP baglantisi kurulamadi (sahte)');
        if (tasiyiciModu === 'basarisiz') return { sent: false, error: 'sahte red' };
        gelen.push(m);
        return { sent: true };
    },
});
const gunluk = [];
const eskiHata = console.error, eskiUyari = console.warn;
console.error = (...a) => { gunluk.push(a.join(' ')); eskiHata.apply(console, a); };
console.warn = (...a) => { gunluk.push(a.join(' ')); eskiUyari.apply(console, a); };
const posta = (alici, parca) => gelen.find(m => m.to === alici && m.subject.includes(parca));

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
    const t = await query(`SELECT id FROM tenants WHERE business_name IN (?, ?, ?)`, [AD.A, AD.B, AD.C]);
    for (const r of t.rows) {
        const sip = await query('SELECT id FROM magaza_siparisler WHERE tenant_id = ?', [r.id]).catch(() => ({ rows: [] }));
        for (const s of sip.rows) {
            await query('DELETE FROM magaza_siparis_gecmisi WHERE siparis_id = ?', [s.id]);
            await query('DELETE FROM magaza_siparis_kalemleri WHERE siparis_id = ?', [s.id]);
            await query('DELETE FROM magaza_siparisler WHERE id = ?', [s.id]);
        }
        await query('DELETE FROM root_olaylar WHERE tenant_id = ?', [r.id]).catch(() => {});
        for (const tb of ['tables', 'lisans_odemeleri', 'license_cache', 'islem_gunlugu', 'aktivasyon_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    const u = await query("SELECT id FROM magaza_urunler WHERE ad LIKE 'MGOTO %'").catch(() => ({ rows: [] }));
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
const gunOnce = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
    require('./server.js');                                     // ayni surecte dinlemeye baslar (initDb dahil)
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(250); }
    Z.durdur();                                                 // zamanlayiciyi test yonetir (elle otomatikIptal)
    await uyu(700);
    await temizle();
    await ayarlariYedekle();
    await uyu(6000);                                            // ensureRootUser 5 sn sonra

    console.log('=== Hazirlik: root, uc isletme, urunler, ayarlar ===');
    let r = await js('/api/root/login', { body: { email: ROOT_EPOSTA, password: ROOT_PAROLA } });
    r = await js('/api/root/totp/kurulum', { body: { code: totp.kodUret(r.d.sir, totp.suankiAdim()) }, token: r.d.kurulumJetonu });
    const ROOT = r.d && r.d.token;
    ok('root oturumu', !!ROOT, r);
    const ac = async (k) => {
        const t = await js('/api/root/tenants', { token: ROOT, body: { businessName: AD[k], ownerEmail: EPOSTA[k], ownerPassword: 'sahip12345',
            phone: '0272 111 22 33', address: 'Dumlupınar Mah. Kurtuluş Cad. No 12, Merkez, Afyonkarahisar' } });
        const g = await js('/api/auth/login', { body: { email: EPOSTA[k], businessCode: t.d.businessCode, password: 'sahip12345' } });
        return { id: t.d.id, token: g.d.token };
    };
    const A = await ac('A'), B = await ac('B'), C = await ac('C');
    ok('uc isletme acildi', !!(A.token && B.token && C.token));
    // Lisansli isletme (onayli ucretli odeme): ayni anda en cok 5 odemesi beklenen siparis
    for (const x of [A, B, C]) {
        await query("INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum) VALUES (?, ?, 'TIER_1_5', '[]', 1000, 'onaylandi')",
            [require('crypto').randomUUID(), x.id]);
    }
    await query("UPDATE tenants SET owner_email = 'pasta@ornek.local' WHERE id = ?", [C.id]);   // gecersiz alici
    const R = (yol, o = {}) => js('/api/root/magaza' + yol, { token: ROOT, ...o });
    const M = (tok) => (yol, o = {}) => js('/api/magaza' + yol, { token: tok, ...o });
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('iban', 'TR00 0000 0000 0000 0000 0000 00') ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger");
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'magaza_otomatik_iptal_gun'");
    const a = await R('/ayarlar', { method: 'PUT', body: { satici: SATICI, acik: true, kargoUcret: 0, kargoUcretsizEsik: 0 } });
    ok('varsayilan otomatik iptal suresi 7 gun', a.status === 200 && a.d.otomatikIptalGun === 7, a.d && a.d.otomatikIptalGun);
    const P1 = (await R('/urunler', { body: { ad: ONEK + 'Stoklu Rulo', fiyat: 100, kdvOrani: 20, stokAdedi: 10, yayin: 'YAYINDA' } })).d;
    const P2 = (await R('/urunler', { body: { ad: ONEK + 'Yazici', fiyat: 50, kdvOrani: 20, yayin: 'YAYINDA' } })).d;
    ok('urunler', !!(P1.id && P2.id));
    const stok = async () => (await query('SELECT stok_adedi FROM magaza_urunler WHERE id = ?', [P1.id])).rows[0].stok_adedi;
    let surum = (await M(A.token)('/hazirlik')).d.kosullar.surum;
    // Otomatik iptal suresi kosul metnine girer: sure degisince surum degisir, isletme yeni metni onaylar
    const surumYenile = async () => { surum = (await M(A.token)('/hazirlik')).d.kosullar.surum; };
    const siparis = async (tok, kalemler) => (await M(tok)('/siparisler', { body: {
        kalemler, kosullarKabul: true, ticariBeyan: true, kosullarSurum: surum,
        teslimat: { alici: 'Ahmet Yılmaz', telefon: '0532 111 22 33', adres: 'Dumlupınar Mah. Kurtuluş Cad. No 12, Merkez, Afyonkarahisar' },
        fatura: { tip: 'KURUMSAL', unvan: 'Test Gıda Ltd. Şti.', vergiDairesi: 'Tınaztepe', vergiNo: '1234567890' } } })).d;
    const D = (id, govde) => R('/siparisler/' + id + '/durum', { body: govde });

    console.log('\n=== 1) Isletmeye e-posta (sahte tasiyici) ===');
    const O1 = await siparis(A.token, [{ urunId: P1.id, adet: 2 }]);
    ok('O1 olustu, stok 10 -> 8', !!O1.id && await stok() === 8, O1);
    await D(O1.id, { durum: 'ODEME_ALINDI' });
    let m = await bekle(() => posta(EPOSTA.A, O1.noMetin + ': ödemeniz alındı'));
    ok('odeme alindi e-postasi isletme sahibine', !!m && m.to === EPOSTA.A, gelen.map(x => [x.to, x.subject]));
    ok('icerik: isletme adi + siparis no + Magaza > Siparislerim yolu + siparis baglantisi',
        !!m && m.html.includes(AD.A) && m.html.includes(O1.noMetin) && m.html.includes('Mağaza &gt; Siparişlerim')
        && m.html.includes('http://panel.test/magaza?siparis=' + O1.id) && m.text.includes('Mağaza > Siparişlerim'), m && m.text);
    ok('konu kurumsal onekli', !!m && m.subject === '[MDA Yazılım] Sipariş ' + O1.noMetin + ': ödemeniz alındı', m && m.subject);
    let sayi = gelen.length;
    await D(O1.id, { durum: 'HAZIRLANIYOR' });
    await uyu(400);
    ok('hazirlaniyor icin e-posta yok', gelen.length === sayi, gelen.length - sayi);
    await D(O1.id, { durum: 'KARGODA', kargoFirma: 'Aras <Kargo>', kargoTakipNo: 'AR998877' });
    m = await bekle(() => posta(EPOSTA.A, O1.noMetin + ' kargoya verildi'));
    ok('kargoya verildi e-postasi: firma + takip no (HTML kacislanmis)', !!m && m.html.includes('Aras &lt;Kargo&gt;') && !m.html.includes('Aras <Kargo>')
        && m.html.includes('AR998877') && m.text.includes('Kargo firması: Aras <Kargo>') && m.text.includes('Takip numarası: AR998877'), m && m.text);
    sayi = gelen.length;
    await D(O1.id, { durum: 'TESLIM_EDILDI' });
    await uyu(400);
    ok('teslim edildi icin e-posta yok', gelen.length === sayi);
    const O2 = await siparis(A.token, [{ urunId: P2.id, adet: 1 }]);
    await D(O2.id, { durum: 'REDDEDILDI', sebep: 'Ödeme ulaşmadı & sipariş kapatıldı' });
    m = await bekle(() => posta(EPOSTA.A, O2.noMetin + ' reddedildi'));
    ok('reddedildi e-postasi: sebep', !!m && m.html.includes('Ödeme ulaşmadı &amp; sipariş kapatıldı') && m.text.includes('Sebep: Ödeme ulaşmadı & sipariş kapatıldı'), m && m.text);

    console.log('\n=== 2) Gonderim hatasi akisi durdurmaz ===');
    const O3 = await siparis(A.token, [{ urunId: P2.id, adet: 1 }]);
    tasiyiciModu = 'firlat';
    let gunlukOnce = gunluk.length;
    let d = await D(O3.id, { durum: 'ODEME_ALINDI' });
    ok('tasiyici hata firlatsa da durum degisti (200)', d.status === 200 && d.d.durum === 'ODEME_ALINDI', d);
    ok('hata gunluge yazildi', !!await bekle(() => gunluk.slice(gunlukOnce).find(x => x.includes('[magaza] e-posta gonderilemedi'))), gunluk.slice(gunlukOnce));
    tasiyiciModu = 'basarisiz';
    gunlukOnce = gunluk.length;
    d = await D(O3.id, { durum: 'KARGODA', kargoFirma: 'PTT Kargo', kargoTakipNo: 'PTT123' });
    ok('tasiyici {sent:false} donse de durum degisti (200)', d.status === 200 && d.d.durum === 'KARGODA', d);
    ok('basarisiz gonderim gunluge yazildi', !!await bekle(() => gunluk.slice(gunlukOnce).find(x => x.includes('[magaza] e-posta gonderilemedi') && x.includes('sahte red'))));
    tasiyiciModu = 'ok';
    const OC = await siparis(C.token, [{ urunId: P2.id, adet: 1 }]);
    gunlukOnce = gunluk.length; sayi = gelen.length;
    d = await D(OC.id, { durum: 'ODEME_ALINDI' });
    ok('alicisi gecersiz isletme: durum degisti, e-posta gonderilmedi, uyari yazildi', d.status === 200 && d.d.durum === 'ODEME_ALINDI'
        && !!await bekle(() => gunluk.slice(gunlukOnce).find(x => x.includes('bildirim atlandi'))) && gelen.length === sayi);
    const dogrudan = await E.durumBildir('yok-boyle-siparis', 'ODEME_ALINDI');
    ok('olmayan siparis icin durumBildir hata firlatmaz', dogrudan && dogrudan.gonderildi === false && dogrudan.sebep === 'SIPARIS_YOK', dogrudan);

    console.log('\n=== 3) Odenmeyen siparisin otomatik iptali (siparise yazilan tarihle) ===');
    const O4 = await siparis(B.token, [{ urunId: P1.id, adet: 3 }]);
    const O5 = await siparis(B.token, [{ urunId: P1.id, adet: 1 }]);
    const O6 = await siparis(B.token, [{ urunId: P1.id, adet: 1 }]);
    ok('stok 8 -> 3 (O4: 3, O5: 1, O6: 1)', await stok() === 3, await stok());
    const k6 = (await query('SELECT created_at, otomatik_iptal_at, otomatik_iptal_gun FROM magaza_siparisler WHERE id = ?', [O6.id])).rows[0];
    ok('olusurken otomatik iptal ani yazildi (olusma + 7 gun)', k6.otomatik_iptal_gun === 7
        && Date.parse(k6.otomatik_iptal_at) - Date.parse(k6.created_at) === 7 * 86400000, k6);
    d = await M(B.token)('/siparisler/' + O6.id);
    ok('isletme ayrintisinda ayni tarih', !!d.d.otomatikIptal && d.d.otomatikIptal.gun === 7 && d.d.otomatikIptal.tarih === k6.otomatik_iptal_at, d.d.otomatikIptal);
    await M(B.token)('/siparisler/' + O5.id + '/odeme-bildir', { body: { referans: 'DEKONT-1' } });
    ok('odeme bildirilmis sipariste otomatik iptal tarihi gosterilmez', !(await M(B.token)('/siparisler/' + O5.id)).d.otomatikIptal);
    await query('UPDATE magaza_siparisler SET otomatik_iptal_at = ? WHERE id IN (?, ?)', [gunOnce(1), O4.id, O5.id]);
    sayi = gelen.length;
    let z = await Z.otomatikIptal();
    ok('tarihi gecmis ve odeme bildirilmemis O4 iptal; odeme bildirilmis O5 ve tarihi gelmemis O6 dokunulmadi',
        z.iptal.length === 1 && z.iptal[0] === O4.id, z);
    d = await M(B.token)('/siparisler/' + O4.id);
    ok('O4: IPTAL, kapatan SISTEM, sebep', d.d.durum === 'IPTAL' && d.d.kapatan === 'SISTEM'
        && d.d.kapanisSebebi === 'Ödeme 7 gün içinde ulaşmadığı için sipariş iptal edildi.' && !!d.d.kapanisAt, d.d);
    ok('stok geri dondu: 3 -> 6', await stok() === 6, await stok());
    ok('O5 hala odeme bekliyor (odeme bildirilmis)', (await M(B.token)('/siparisler/' + O5.id)).d.durum === 'ODEME_BEKLENIYOR');
    ok('O6 hala odeme bekliyor (tarihi gelmedi)', (await M(B.token)('/siparisler/' + O6.id)).d.durum === 'ODEME_BEKLENIYOR');
    d = await R('/siparisler/' + O4.id);
    ok('gecmise yazildi (IPTAL, SISTEM)', d.d.gecmis.some(x => x.olay === 'IPTAL' && x.kim === 'SISTEM' && x.aciklama.startsWith('Ödeme 7 gün')), d.d.gecmis);
    m = posta(EPOSTA.B, O4.noMetin + ' iptal edildi');
    ok('otomatik iptal e-postasi: sebep', !!m && m.text.includes('Sebep: Ödeme 7 gün içinde ulaşmadığı için sipariş iptal edildi.') && m.html.includes(AD.B), gelen.slice(sayi).map(x => x.subject));
    z = await Z.otomatikIptal();
    ok('ikinci tarama: iptal yok, cift stok iadesi yok', z.iptal.length === 0 && await stok() === 6, [z, await stok()]);
    const surum7 = surum;
    ok('ayar 0 kabul edilir', (await R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: 0 } })).d.otomatikIptalGun === 0);
    await surumYenile();
    ok('sure degisince kosul surumu degisir (metindeki iptal cumlesi)', surum !== surum7);
    const O7 = await siparis(B.token, [{ urunId: P1.id, adet: 1 }]);
    ok('ayar 0 iken olusan siparise otomatik iptal tarihi yazilmaz', (await query('SELECT otomatik_iptal_at FROM magaza_siparisler WHERE id = ?', [O7.id])).rows[0].otomatik_iptal_at === null
        && !(await M(B.token)('/siparisler/' + O7.id)).d.otomatikIptal);
    z = await Z.otomatikIptal({ simdi: new Date(Date.now() + 8 * 86400000) });
    ok('ayar 0 olsa da eski O6 kendi tarihiyle iptal; tarihsiz O7 iptal olmaz (ayar geriye donuk uygulanmaz)',
        z.iptal.length === 1 && z.iptal[0] === O6.id && (await M(B.token)('/siparisler/' + O7.id)).d.durum === 'ODEME_BEKLENIYOR', z);
    ok('O6 sebebi kendi suresiyle (7 gun)', (await M(B.token)('/siparisler/' + O6.id)).d.kapanisSebebi === 'Ödeme 7 gün içinde ulaşmadığı için sipariş iptal edildi.');
    ok('gecersiz sure 400 (366, -1, 2,5, yazi)', (await Promise.all([366, -1, 2.5, 'abc'].map(v => R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: v } }))))
        .every(x => x.status === 400));
    await R('/ayarlar', { method: 'PUT', body: { otomatikIptalGun: 3 } });
    await surumYenile();
    const OUC = await siparis(B.token, [{ urunId: P1.id, adet: 1 }]);
    z = await Z.otomatikIptal({ simdi: new Date(Date.now() + 2 * 86400000) });
    ok('sure 3 gun: 2. gunde iptal yok', z.iptal.length === 0, z);
    tasiyiciModu = 'firlat';
    gunlukOnce = gunluk.length;
    z = await Z.otomatikIptal({ simdi: new Date(Date.now() + 3 * 86400000 + 3600000) });
    ok('sure 3 gun: 3 gun dolunca iptal; tarihsiz O7 yine dokunulmadi', z.iptal.length === 1 && z.iptal[0] === OUC.id
        && (await M(B.token)('/siparisler/' + O7.id)).d.durum === 'ODEME_BEKLENIYOR', z);
    ok('sebep siparisin kendi suresiyle (3 gun)', (await M(B.token)('/siparisler/' + OUC.id)).d.kapanisSebebi === 'Ödeme 3 gün içinde ulaşmadığı için sipariş iptal edildi.');
    ok('e-posta hatasi otomatik iptali durdurmadi + gunluge yazildi', gunluk.slice(gunlukOnce).some(x => x.includes('[magaza] e-posta gonderilemedi')));
    tasiyiciModu = 'ok';
    ok('stok iadeleri dogru (10 - O1 2 - O5 1 - O7 1 = 6)', await stok() === 6, await stok());

    console.log('\n=== 3b) Onay bekleyen odeme hatirlatmasi (Patron) ===');
    const loglar = []; const eskiLog = console.log;
    console.log = (...x) => { loglar.push(x.join(' ')); eskiLog.apply(console, x); };
    await query('UPDATE magaza_siparisler SET odeme_bildirildi_at = ? WHERE id = ?', [new Date(Date.now() - 2.5 * 86400000).toISOString(), O5.id]);
    let hz = await Z.hatirlatmalar();
    ok('2. gun: bir hatirlatma (asama 2)', hz.gonderilen.length === 1 && hz.gonderilen[0].id === O5.id && hz.gonderilen[0].asama === 2, hz);
    const olayH = (await query("SELECT * FROM root_olaylar WHERE tur = 'magaza_hatirlatma' AND ref = ?", [O5.id + ':2'])).rows[0];
    ok('root_olaylar magaza_hatirlatma yazildi', !!olayH && olayH.detay.includes('2 gündür onay bekliyor'), olayH);
    ok('Patron\'a e-posta denendi (rootaBildir)', !!await bekle(() => loglar.find(x => x.includes('[email/DEV]') && x.includes('onay bekliyor'))));
    hz = await Z.hatirlatmalar();
    ok('ayni gun ikinci hatirlatma yok', hz.gonderilen.length === 0, hz);
    hz = await Z.hatirlatmalar({ simdi: new Date(Date.now() + 0.6 * 86400000) });
    ok('3. gune girdi ama son hatirlatmadan 24 saat gecmedi: yok (gunde en cok bir)', hz.gonderilen.length === 0, hz);
    hz = await Z.hatirlatmalar({ simdi: new Date(Date.now() + 1.1 * 86400000) });
    ok('3. gun: bir kez daha (asama 3)', hz.gonderilen.length === 1 && hz.gonderilen[0].id === O5.id && hz.gonderilen[0].asama === 3, hz);
    hz = await Z.hatirlatmalar({ simdi: new Date(Date.now() + 6 * 86400000) });
    ok('ucuncu hatirlatma yok', hz.gonderilen.length === 0, hz);
    const OHT = await siparis(B.token, [{ urunId: P2.id, adet: 1 }]);
    await M(B.token)('/siparisler/' + OHT.id + '/odeme-bildir', { body: {} });
    await query('UPDATE magaza_siparisler SET odeme_bildirildi_at = ? WHERE id = ?', [new Date(Date.now() - 3.5 * 86400000).toISOString(), OHT.id]);
    hz = await Z.hatirlatmalar();
    ok('gecikmis tarama: hic hatirlatilmamis 3,5 gunluk sipariste yalniz bir hatirlatma (asama 3)',
        hz.gonderilen.length === 1 && hz.gonderilen[0].id === OHT.id && hz.gonderilen[0].asama === 3, hz);
    await D(OHT.id, { durum: 'ODEME_ALINDI' });
    hz = await Z.hatirlatmalar({ simdi: new Date(Date.now() + 10 * 86400000) });
    ok('onaylanan sipariste hatirlatma yok', !hz.gonderilen.some(x => x.id === OHT.id), hz);
    console.log = eskiLog;

    console.log('\n=== 4) Lisansi salt-okunur isletmede magaza uclari acik ===');
    // Karar (D1, 2026-11-12): suresi dolmus lisansta magazada YENI siparis ve sepet yok, urun listesi de kapali;
    // yalniz siparislerim, ayrinti (havale bilgisi), "odemeyi yaptim" ve iptal acik (KAPALI'da da).
    ok('lisans kurali: suresi dolmusta yalniz siparis izleme / odeme bildirimi / iptal',
        L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/magaza/siparisler/x/iptal' }) === true
        && L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/magaza/siparisler/x/odeme-bildir' }) === true
        && L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/magaza/sepet' }) === false
        && L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/magaza/siparisler' }) === false
        && L.saltOkunurdaGecerMi({ method: 'GET', originalUrl: '/api/magaza/urunler' }) === false
        && L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/orders' }) === false);
    // Bekleyen siparisler lisans AKTIF iken verilir
    const O8 = await siparis(A.token, [{ urunId: P2.id, adet: 1 }]);
    const O9 = await siparis(A.token, [{ urunId: P2.id, adet: 1 }]);
    ok('lisans aktifken iki siparis verildi', !!(O8 && O8.id && O9 && O9.id), [O8, O9]);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [gunOnce(1), A.id]);
    const me = await js('/api/auth/me', { token: A.token });
    ok('A artik SALT_OKUNUR', me.status === 200 && me.d.lisansDurum === 'SALT_OKUNUR', me.d && me.d.lisansDurum);
    ok('baska modulde yazma hala kapali (POST /api/tables 403 LICENSE_READONLY)', (d = await js('/api/tables', { token: A.token, body: { code: 'Z1', name: 'Z1' } })).status === 403
        && d.d.code === 'LICENSE_READONLY', d);
    ok('GET /api/magaza/durum 200', (await M(A.token)('/durum')).status === 200);
    ok('SALT_OKUNUR: sepet 403 LICENSE_READONLY', (d = await M(A.token)('/sepet', { body: { kalemler: [{ urunId: P2.id, adet: 1 }] } })).status === 403
        && d.d.code === 'LICENSE_READONLY', d);
    ok('SALT_OKUNUR: yeni siparis 403', (d = await M(A.token)('/siparisler', { body: {} })).status === 403 && d.d.code === 'LICENSE_READONLY', d);
    ok('SALT_OKUNUR: urun listesi 403', (await M(A.token)('/urunler')).status === 403);
    ok('SALT_OKUNUR: siparislerim ve ayrinti (havale bilgisiyle) acik', (await M(A.token)('/siparisler')).status === 200
        && ((x) => x.status === 200 && !!x.d.odeme)(await M(A.token)('/siparisler/' + O8.id)));
    ok('odeme bildirimi yapilabilir', (d = await M(A.token)('/siparisler/' + O8.id + '/odeme-bildir', { body: {} })).status === 200 && !!d.d.odemeBildirildiAt, d);
    ok('iptal edilebilir', (d = await M(A.token)('/siparisler/' + O9.id + '/iptal', { body: {} })).status === 200 && d.d.durum === 'IPTAL', d);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [gunOnce(10), A.id]);
    ok('lisans KAPALI: siparis izleme acik (durum, siparislerim, ayrinti)', (await M(A.token)('/durum')).status === 200
        && (await M(A.token)('/siparisler')).status === 200 && (await M(A.token)('/siparisler/' + O8.id)).status === 200);
    ok('lisans KAPALI: sepet / yeni siparis / urunler 403 LICENSE_EXPIRED',
        ((x) => x.status === 403 && x.d.code === 'LICENSE_EXPIRED')(await M(A.token)('/sepet', { body: { kalemler: [{ urunId: P2.id, adet: 1 }] } }))
        && (await M(A.token)('/siparisler', { body: {} })).status === 403 && (await M(A.token)('/urunler')).status === 403);

    E.tasiyiciAyarla(null);
    console.error = eskiHata; console.warn = eskiUyari;
    await temizle();
    await ayarlariGeriYukle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => {
    console.error = eskiHata; console.warn = eskiUyari;
    console.error('COKTU:', e);
    try { await temizle(); await ayarlariGeriYukle(); } catch (_) {}
    process.exit(1);
});
