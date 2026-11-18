// SofraMix paketleri (POS tarafi): herkese acik paket listesi, imzali durum ucu, paket secimli provizyon,
// tutar karsilastirmasi, eslesme guvenligi (ikinci sube, yerel e-posta) ve root cozumu.
// Portlar: 47301 (asil sunucu), 47302 (gizli anahtarsiz sunucu).
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47301, PORT_KAPALI = 47302;
const TABAN = `http://127.0.0.1:${PORT}`;
const GIZLI = 'smx-paket-test-gizli-' + crypto.randomBytes(8).toString('hex');
const ON = 'SMXPKT';

const uyu = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const gun = (n) => new Date(Date.now() + n * 86400000).toISOString();
const smxNo = () => String(880000000 + Math.floor(Math.random() * 99999999));
const odeme = (x = {}) => ({
    odeme_id: `${ON}-${uuid().slice(0, 12)}`, business_id: null, isletme_adi: `${ON} Lokanta`,
    yetkili_email: null, yetkili_tel: null, tutar_kurus: 1000000, kdv_kurus: 200000, yontem: 'havale',
    onay_tarihi: new Date().toISOString(), ...x,
});
const modulleri = async (id) => JSON.parse((await query('SELECT license_modules FROM tenants WHERE id = ?', [id])).rows[0].license_modules || '[]');
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];

// Imzali durum istegi (SofraMix ile ayni duzen: base64url JSON + HMAC hex, metnin kendisi uzerinden)
function durumAdresi(g, gizli = GIZLI) {
    const metin = JSON.stringify(g, Object.keys(g).sort());
    const yuk = Buffer.from(metin, 'utf8').toString('base64url');
    const imza = crypto.createHmac('sha256', gizli).update(metin).digest('hex');
    return `/api/public/soframix-durum?yuk=${yuk}&imza=${imza}`;
}
const durumGovde = (no, ek = {}) => ({ kaynak: 'soframix', surum: 1, amac: 'durum', isletme_no: Number(no), zaman: Math.floor(Date.now() / 1000), ...ek });
async function al(yol, port = PORT) {
    const r = await fetch(`http://127.0.0.1:${port}${yol}`);
    return { status: r.status, cache: r.headers.get('cache-control'), d: await r.json().catch(() => null) };
}

// Katalog ve ayar test icin degisir; sonunda aynen geri yazilir.
let eskiKatalog = [];
let eskiTam = null;
async function katalogHazirla() {
    eskiKatalog = (await query('SELECT id, fiyat, smx_fiyat, gorunur FROM lisans_katalog')).rows;
    eskiTam = (await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'smx_tam_paket_fiyat'")).rows[0] || null;
    const yaz = (id, fiyat, smx, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, smx_fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, smx, gorunur, id]);
    await yaz('TIER-TIER_1_5', 3000, 2500);
    await yaz('TIER-TIER_6_10', 4000, null);
    await yaz('TIER-TIER_11_20', 6000, 5000);
    await yaz('TIER-TIER_20_PLUS', 8000, 7000);
    await yaz('MODUL-BASE', 0, null);
    await yaz('MODUL-MENU_DIGITAL', 1000, 800);
    await yaz('MODUL-GARSON', 500, null);
    await yaz('MODUL-STOK', 700, 600);
    await yaz('MODUL-QR_SIPARIS', 900, 700, 0);       // gizli: listede yok, satin alinamaz
    await yaz('MODUL-MARKETPLACE', 0, null, 0);       // gizli (varsayilan)
    await query(`INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('smx_tam_paket_fiyat', '9000')
                 ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger`);
}
async function katalogGeriYaz() {
    for (const r of eskiKatalog) await query('UPDATE lisans_katalog SET fiyat = ?, smx_fiyat = ?, gorunur = ? WHERE id = ?', [r.fiyat, r.smx_fiyat, r.gorunur, r.id]);
    if (eskiTam) await query("UPDATE sistem_ayarlari SET deger = ? WHERE anahtar = 'smx_tam_paket_fiyat'", [eskiTam.deger]);
    else await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'smx_tam_paket_fiyat'");
}

async function temizle() {
    const t = await query('SELECT id FROM tenants WHERE business_name LIKE ?', [`${ON} %`]);
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'marketplace_credentials', 'marketplace_store_links',
            'marketplace_channels', 'license_cache', 'islem_gunlugu', 'gecis_haklari', 'yonetim_gunlugu']) {
            await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query('DELETE FROM pos_provizyon WHERE odeme_id LIKE ?', [`${ON}-%`]);
    await query('DELETE FROM yonetim_gunlugu WHERE ozet LIKE ?', [`%${ON}-%`]).catch(() => {});
}

// Elle kiraci (deneme ya da yerel isletme)
async function kiraciKur({ ad, tier = 'TIER_DENEME', parent = null, eposta = null, tel = null, smx = null, moduller = ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK', 'MARKETPLACE'], limit = null }) {
    const id = uuid();
    await query(`INSERT INTO tenants (id, slug, business_code, business_name, parent_org, owner_email, phone, license_tier,
                                      license_modules, license_end_date, license_table_limit, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, 'smxpkt-' + uuid().slice(0, 8), String(60000000 + Math.floor(Math.random() * 9999999)), `${ON} ${ad}`, parent,
            eposta, tel, tier, JSON.stringify(moduller), gun(5), limit]);
    if (smx || tel) {
        const tn = tel ? String(tel).replace(/\D/g, '').slice(-10) : null;
        await query(`INSERT INTO deneme_kayitlari (id, tenant_id, telefon_norm, soframix_business_id, isletme_adi, kaynak, bitis)
                     VALUES (?, ?, ?, ?, ?, 'soframix', ?)`, [uuid(), id, tn, smx, `${ON} ${ad}`, gun(5)]);
    }
    return id;
}

(async () => {
    initDb(); await uyu(900);
    await temizle();
    await katalogHazirla();
    const P = require('./src/services/posProvizyon');
    const SP = require('./src/services/soframixPaket');

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, JWT_SECRET: 'smx-paket-test', ROOT_EMAIL: '', ROOT_PASSWORD: '',
            SOFRAMIX_PLATFORM_URL: '', SOFRAMIX_PLATFORM_ANAHTAR: '' } });
    const kapali = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT_KAPALI), SOFRAMIX_DENEME_GIZLI: '', JWT_SECRET: 'smx-paket-test', ROOT_EMAIL: '', ROOT_PASSWORD: '',
            SOFRAMIX_PLATFORM_URL: '', SOFRAMIX_PLATFORM_ANAHTAR: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} try { kapali.kill(); } catch (_) {} });
    for (const p of [PORT, PORT_KAPALI]) {
        for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) break; } catch (_) {} await uyu(400); }
    }
    await uyu(1200);

    console.log('\n=== 1) GET /api/public/soframix-paketler ===');
    const pk = await al('/api/public/soframix-paketler');
    const d = pk.d || {};
    ok('200', pk.status === 200, pk.status);
    ok('Cache-Control public, max-age=60', /public/.test(pk.cache || '') && /max-age=60/.test(pk.cache || ''), pk.cache);
    ok('surum 1, kdvOrani 20', d.surum === 1 && d.kdvOrani === 20, { surum: d.surum, kdv: d.kdvOrani });
    const anahtarlar = ['surum', 'kdvOrani', 'tamPaket', 'masaPaketleri', 'moduller', 'zorunluModuller', 'notlar'];
    ok('ust alanlar tam ve fazlasiz', JSON.stringify(Object.keys(d).sort()) === JSON.stringify(anahtarlar.slice().sort()), Object.keys(d));
    const t15 = (d.masaPaketleri || []).find((x) => x.kod === 'TIER_1_5');
    ok('masa paketi: normal 3000, smx 2500, sinir 5', t15 && t15.normalFiyat === 3000 && t15.smxFiyat === 2500 && t15.masaSiniri === 5 && t15.ad, t15);
    const t610 = (d.masaPaketleri || []).find((x) => x.kod === 'TIER_6_10');
    ok('smx_fiyat bos -> smxFiyat = normal', t610 && t610.smxFiyat === 4000, t610);
    ok('masa paketi alanlari', t15 && JSON.stringify(Object.keys(t15).sort()) === JSON.stringify(['ad', 'kod', 'masaSiniri', 'normalFiyat', 'smxFiyat']), t15 && Object.keys(t15));
    const mod = (k) => (d.moduller || []).find((x) => x.kod === k);
    ok('BASE: fiyat 0, fiyatMasaPaketinden', mod('BASE') && mod('BASE').normalFiyat === 0 && mod('BASE').smxFiyat === 0 && mod('BASE').fiyatMasaPaketinden === true, mod('BASE'));
    ok('QR Menu: normal 1000, smx 800, gerekir []', mod('MENU_DIGITAL') && mod('MENU_DIGITAL').normalFiyat === 1000 && mod('MENU_DIGITAL').smxFiyat === 800
        && Array.isArray(mod('MENU_DIGITAL').gerekir) && mod('MENU_DIGITAL').gerekir.length === 0, mod('MENU_DIGITAL'));
    ok('Stok gerekir BASE (bagimlilik kuralindan)', mod('STOK') && JSON.stringify(mod('STOK').gerekir) === '["BASE"]', mod('STOK'));
    ok('Garson gerekir bos degil (en az bir on kosul)', mod('GARSON') && mod('GARSON').gerekir.length >= 1 && mod('GARSON').smxFiyat === 500, mod('GARSON'));
    ok('gizli moduller listede yok (QR_SIPARIS, MARKETPLACE)', !mod('QR_SIPARIS') && !mod('MARKETPLACE'));
    ok('modul alanlari', mod('STOK') && JSON.stringify(Object.keys(mod('STOK')).sort()) === JSON.stringify(['ad', 'aciklama', 'fiyatMasaPaketinden', 'gerekir', 'kod', 'normalFiyat', 'smxFiyat'].sort()), mod('STOK') && Object.keys(mod('STOK')));
    ok('zorunluModuller MARKETPLACE', JSON.stringify(d.zorunluModuller) === '["MARKETPLACE"]', d.zorunluModuller);
    ok('notlar', Array.isArray(d.notlar) && d.notlar[0] === 'Fiyatlar yıllıktır ve KDV hariçtir.' && d.notlar.length === 2, d.notlar);
    const tp = d.tamPaket || {};
    ok('tam paket: kod/ad/sinirsiz', tp.kod === 'TAM' && tp.ad === 'Tam paket' && tp.masaSiniri === null && tp.aciklama === 'Tüm modüller açık, sınırsız masa', tp);
    ok('tam paket modulleri = provizyonun tam listesi', JSON.stringify(tp.moduller) === JSON.stringify(P.VARSAYILAN_MODULLER), tp.moduller);
    ok('modulAdlari ayni uzunlukta', Array.isArray(tp.modulAdlari) && tp.modulAdlari.length === (tp.moduller || []).length, tp.modulAdlari);
    // 20+ masa (8000) + satistaki moduller (QR Menu 1000 + Garson 500 + Stok 700) = 10200
    ok('tam paket normalFiyat = 20+ masa + satistaki moduller', tp.normalFiyat === 10200, tp.normalFiyat);
    ok('tam paket smxFiyat = root ayari', tp.smxFiyat === 9000, tp.smxFiyat);
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'smx_tam_paket_fiyat'");
    ok('ayar bos -> tamPaket null', (await SP.paketler()).tamPaket === null);
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('kdv_orani', '18') ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger");
    ok('kdv_orani ayari varsa o', (await SP.paketler()).kdvOrani === 18);
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'kdv_orani'");
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('smx_tam_paket_fiyat', '9000')");

    console.log('\n=== 2) Provizyon: pos_paket null (eski odeme) ===');
    const no1 = smxNo();
    const s1 = await P.odemeIsle(odeme({ business_id: no1, isletme_adi: `${ON} Eski`, yetkili_email: `${ON.toLowerCase()}1@ornek.test`, pos_paket: null }));
    const k1 = s1.tenantId && await kiraci(s1.tenantId);
    ok('islendi, kiraci acildi', s1.durum === 'islendi' && s1.kiraciAcildi, s1);
    ok('eski davranis: TIER_SOFRAMIX + varsayilan moduller', k1 && k1.license_tier === 'TIER_SOFRAMIX'
        && JSON.stringify(await modulleri(s1.tenantId)) === JSON.stringify(P.VARSAYILAN_MODULLER), k1 && [k1.license_tier, k1.license_modules]);

    console.log('\n=== 3) Provizyon: tam paket ===');
    const no2 = smxNo();
    const tam = { surum: 1, tur: 'tam', tier: null, moduller: P.VARSAYILAN_MODULLER, smxTutarKurus: 900000 };
    const s2 = await P.odemeIsle(odeme({ business_id: no2, isletme_adi: `${ON} Tam`, yetkili_email: `${ON.toLowerCase()}2@ornek.test`, pos_paket: tam }));
    const k2 = s2.tenantId && await kiraci(s2.tenantId);
    ok('islendi', s2.durum === 'islendi' && s2.paketTur === 'tam', s2);
    ok('TIER_SOFRAMIX, sinirsiz, SofraMix', k2 && k2.license_tier === 'TIER_SOFRAMIX' && k2.license_table_limit == null && k2.parent_org === 'SofraMix', k2);
    const p2 = (await query('SELECT pos_paket FROM pos_provizyon WHERE tenant_id = ?', [s2.tenantId])).rows[0];
    ok('paket secimi kayda yazildi', p2 && JSON.parse(p2.pos_paket).tur === 'tam', p2);
    // tutar uyusmazligi
    const no3 = smxNo();
    const o3 = odeme({ business_id: no3, isletme_adi: `${ON} Tam Yanlis`, yetkili_email: `${ON.toLowerCase()}3@ornek.test`, pos_paket: JSON.stringify({ ...tam, smxTutarKurus: 500000 }) });
    const s3 = await P.odemeIsle(o3);
    ok('tutar uyusmazligi -> elde, kiraci acilmadi', s3.durum === 'elde' && s3.sebep === 'tutar_uyumsuz' && !s3.tenantId, s3);
    const r3 = (await query('SELECT * FROM pos_provizyon WHERE odeme_id = ?', [o3.odeme_id])).rows[0];
    ok('elde kaydi: sebep + paket saklandi', r3 && r3.durum === 'elde' && r3.elde_sebep === 'tutar_uyumsuz' && JSON.parse(r3.pos_paket).smxTutarKurus === 500000, r3);
    ok('hata metni Turkce ve duz tire', r3 && /uyuşmuyor/.test(r3.hata) && !/[–—−]/.test(r3.hata), r3 && r3.hata);
    ok('tekrar denemede yine elde (karar yok)', (await P.kayittanTekrarIsle(r3)).durum === 'elde');
    const s3b = await P.kayittanTekrarIsle(r3, { tutarKabul: true });
    ok('root tutari kabul edince islendi (paket korunarak)', s3b.durum === 'islendi' && s3b.paketTur === 'tam', s3b);
    // Tolerans 1 TL
    const s3c = await P.odemeIsle(odeme({ business_id: smxNo(), isletme_adi: `${ON} Tam Tolerans`, yetkili_email: `${ON.toLowerCase()}3c@ornek.test`, pos_paket: { ...tam, smxTutarKurus: 900080 } }));
    ok('0,80 TL fark tolerans icinde', s3c.durum === 'islendi', s3c);

    console.log('\n=== 4) Provizyon: ozel paket ===');
    const ozel = { surum: 1, tur: 'ozel', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], smxTutarKurus: (4000 + 800) * 100 };
    const s4 = await P.odemeIsle(odeme({ business_id: smxNo(), isletme_adi: `${ON} Ozel`, yetkili_email: `${ON.toLowerCase()}4@ornek.test`, pos_paket: ozel }));
    const k4 = s4.tenantId && await kiraci(s4.tenantId);
    ok('islendi', s4.durum === 'islendi' && s4.paketTur === 'ozel', s4);
    ok('kademe TIER_6_10, sinir 10', k4 && k4.license_tier === 'TIER_6_10' && Number(k4.license_table_limit) === 10, k4 && [k4.license_tier, k4.license_table_limit]);
    ok('yalniz secilenler + MARKETPLACE', JSON.stringify((await modulleri(s4.tenantId)).sort()) === JSON.stringify(['BASE', 'MARKETPLACE', 'MENU_DIGITAL']), await modulleri(s4.tenantId));
    ok('parent_org SofraMix', k4 && k4.parent_org === 'SofraMix');
    // Yalniz QR menu (masa paketi yok)
    const s5 = await P.odemeIsle(odeme({ business_id: smxNo(), isletme_adi: `${ON} Yalniz Menu`, yetkili_email: `${ON.toLowerCase()}5@ornek.test`,
        pos_paket: { surum: 1, tur: 'ozel', tier: null, moduller: ['MENU_DIGITAL'], smxTutarKurus: 80000 } }));
    const k5 = s5.tenantId && await kiraci(s5.tenantId);
    ok('yalniz QR menu: islendi', s5.durum === 'islendi', s5);
    ok('yalniz QR menu: TIER_SOFRAMIX, sinirsiz, yalniz MENU_DIGITAL', k5 && k5.license_tier === 'TIER_SOFRAMIX' && k5.license_table_limit == null
        && JSON.stringify(await modulleri(s5.tenantId)) === '["MENU_DIGITAL"]', k5 && [k5.license_tier, k5.license_modules]);
    // Gecersiz secimler
    const gecersiz = async (pp, ad) => (await P.odemeIsle(odeme({ business_id: smxNo(), isletme_adi: `${ON} ${ad}`, yetkili_email: `${ON.toLowerCase()}${uuid().slice(0, 5)}@ornek.test`, pos_paket: pp })));
    const g1 = await gecersiz({ surum: 1, tur: 'ozel', tier: null, moduller: ['BASE'], smxTutarKurus: 0 }, 'Gecersiz1');
    ok('Adisyon ve Kasa var, masa paketi yok -> elde paket_gecersiz', g1.durum === 'elde' && g1.sebep === 'paket_gecersiz', g1);
    const g2 = await gecersiz({ surum: 1, tur: 'ozel', tier: 'TIER_1_5', moduller: ['BASE', 'QR_SIPARIS', 'MENU_DIGITAL'], smxTutarKurus: 0 }, 'Gecersiz2');
    ok('gizli modul -> elde', g2.durum === 'elde' && g2.sebep === 'paket_gecersiz', g2);
    const g3 = await gecersiz({ surum: 1, tur: 'ozel', tier: null, moduller: ['GARSON'], smxTutarKurus: 50000 }, 'Gecersiz3');
    ok('bagimlilik karsilanmiyor (Garson tek basina) -> elde', g3.durum === 'elde' && g3.sebep === 'paket_gecersiz', g3);
    const g4 = await gecersiz({ surum: 1, tur: 'ozel', tier: 'TIER_DENEME', moduller: ['BASE'], smxTutarKurus: 0 }, 'Gecersiz4');
    ok('satista olmayan kademe -> elde', g4.durum === 'elde' && g4.sebep === 'paket_gecersiz', g4);
    const g5 = await gecersiz({ surum: 2, tur: 'tam', smxTutarKurus: 900000 }, 'Gecersiz5');
    ok('bilinmeyen surum -> elde', g5.durum === 'elde' && g5.sebep === 'paket_gecersiz', g5);
    const g6 = await gecersiz({ ...ozel, smxTutarKurus: 450000 }, 'Gecersiz6');
    ok('ozel paket tutar uyusmazligi -> elde tutar_uyumsuz', g6.durum === 'elde' && g6.sebep === 'tutar_uyumsuz', g6);
    const g7 = await gecersiz({ surum: 1, tur: 'ozel', tier: 'TIER_1_5', moduller: ['BASE', 'STOK', 'MARKETPLACE'], smxTutarKurus: (2500 + 600) * 100 }, 'Ozel Stok');
    ok('MARKETPLACE istekte gelse de ucrete girmez, kabul', g7.durum === 'islendi' && (await modulleri(g7.tenantId)).includes('MARKETPLACE'), g7);

    console.log('\n=== 5) Deneme (TIER_DENEME) odeme sonrasi kalmaz ===');
    const no6 = smxNo();
    const d6 = await kiraciKur({ ad: 'Deneme Eski', smx: no6, parent: 'SofraMix' });
    const s6 = await P.odemeIsle(odeme({ business_id: no6, isletme_adi: `${ON} Deneme Eski`, pos_paket: null }));
    const k6 = await kiraci(d6);
    ok('ayni kiraci', s6.durum === 'islendi' && s6.tenantId === d6 && s6.esles === 'deneme_smx', s6);
    ok('eski odeme: TIER_DENEME -> TIER_SOFRAMIX, sinirsiz', k6.license_tier === 'TIER_SOFRAMIX' && k6.license_table_limit == null, [k6.license_tier, k6.license_table_limit]);
    const no7 = smxNo();
    const d7 = await kiraciKur({ ad: 'Deneme Ozel', smx: no7, parent: 'SofraMix' });
    const s7 = await P.odemeIsle(odeme({ business_id: no7, isletme_adi: `${ON} Deneme Ozel`,
        pos_paket: { surum: 1, tur: 'ozel', tier: 'TIER_1_5', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'], smxTutarKurus: (2500 + 800 + 500) * 100 } }));
    const k7 = await kiraci(d7);
    ok('ozel: deneme kiracisi', s7.durum === 'islendi' && s7.tenantId === d7, s7);
    ok('ozel: TIER_1_5, sinir 5', k7.license_tier === 'TIER_1_5' && Number(k7.license_table_limit) === 5, [k7.license_tier, k7.license_table_limit]);
    ok('ozel: denemedeki diger moduller kapandi (yalniz secilenler + MARKETPLACE)',
        JSON.stringify((await modulleri(d7)).sort()) === JSON.stringify(['BASE', 'GARSON', 'MARKETPLACE', 'MENU_DIGITAL']), await modulleri(d7));
    const no8 = smxNo();
    const d8 = await kiraciKur({ ad: 'Deneme Tam', smx: no8, parent: 'SofraMix' });
    await P.odemeIsle(odeme({ business_id: no8, isletme_adi: `${ON} Deneme Tam`, pos_paket: tam }));
    ok('tam: TIER_DENEME -> TIER_SOFRAMIX', (await kiraci(d8)).license_tier === 'TIER_SOFRAMIX');

    console.log('\n=== 6) Ikinci sube: ayni telefon, farkli SofraMix no -> elde, birlesmez ===');
    const noA = smxNo(), noB = smxNo();
    const tel = '0533 ' + String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7);
    const a = await kiraciKur({ ad: 'Sube A', smx: noA, tel, parent: 'SofraMix' });
    const aOnce = await kiraci(a);
    const oB = odeme({ business_id: noB, isletme_adi: `${ON} Sube B`, yetkili_tel: tel, yetkili_email: `${ON.toLowerCase()}b@ornek.test`, pos_paket: tam });
    const sB = await P.odemeIsle(oB);
    ok('elde: farkli_smx', sB.durum === 'elde' && sB.sebep === 'farkli_smx' && sB.adayTenantId === a, sB);
    ok('uyari metni "Farklı SofraMix işletmesi"', /Farklı SofraMix işletmesi/.test(sB.uyari || ''), sB.uyari);
    const aSonra = await kiraci(a);
    ok('A subesinin lisansi DEGISMEDI', aSonra.license_end_date === aOnce.license_end_date && aSonra.license_tier === aOnce.license_tier);
    // Root: yeni isletme olarak ac (controller uzerinden)
    const ctrl = require('./src/controllers/soframixPaketController');
    const cevap = async (params, body) => {
        let kod = 200, govde = null;
        const res = { status(k) { kod = k; return this; }, json(g) { govde = g; return this; }, set() { return this; } };
        await ctrl.rootCoz({ params, body, root: { id: null } }, res);
        return { kod, govde };
    };
    const rB = await cevap({ odemeId: oB.odeme_id }, { islem: 'yeni' });
    ok('root "Yeni işletme olarak aç" -> islendi, yeni kiraci', rB.kod === 200 && rB.govde.durum === 'islendi' && rB.govde.kiraciAcildi && rB.govde.tenantId !== a, rB);
    ok('yanitta ham aktivasyon jetonu yok', rB.govde && !('aktivasyonJetonu' in rB.govde));
    ok('yeni sube TIER_SOFRAMIX + SofraMix', rB.govde && (await kiraci(rB.govde.tenantId)).parent_org === 'SofraMix');
    ok('A yine degismedi', (await kiraci(a)).license_end_date === aOnce.license_end_date);
    ok('islenmis odemede cozum 409', (await cevap({ odemeId: oB.odeme_id }, { islem: 'yeni' })).kod === 409);
    ok('bilinmeyen islem 400 / odeme yok 404', (await cevap({ odemeId: oB.odeme_id + 'x' }, { islem: 'yeni' })).kod === 404);

    console.log('\n=== 7) Yalniz e-postayla eslesen YEREL isletme -> elde ===');
    const yerelEposta = `${ON.toLowerCase()}yerel${uuid().slice(0, 5)}@ornek.test`;
    const l = await kiraciKur({ ad: 'Yerel', tier: 'TIER_6_10', eposta: yerelEposta, limit: 10, moduller: ['BASE', 'MENU_DIGITAL'] });
    const lOnce = await kiraci(l);
    const oL = odeme({ business_id: smxNo(), isletme_adi: `${ON} Yerel SMX`, yetkili_email: yerelEposta, pos_paket: tam });
    const sL = await P.odemeIsle(oL);
    ok('elde: yerel_eposta, aday = yerel isletme', sL.durum === 'elde' && sL.sebep === 'yerel_eposta' && sL.adayTenantId === l, sL);
    const lAra = await kiraci(l);
    ok('yerel isletme sessizce cevrilmedi', lAra.license_tier === 'TIER_6_10' && lAra.parent_org == null && lAra.license_end_date === lOnce.license_end_date, lAra);
    const rL = await cevap({ odemeId: oL.odeme_id }, { islem: 'aday' });
    ok('root "Önerilen işletmeye yaz" -> islendi, ayni kiraci', rL.govde && rL.govde.durum === 'islendi' && rL.govde.tenantId === l, rL);
    ok('yerel isletme artik SofraMix tam paket', (await kiraci(l)).license_tier === 'TIER_SOFRAMIX' && (await kiraci(l)).parent_org === 'SofraMix');
    // SofraMix numarasi olmayan odeme + e-postayla bulunan SofraMix kiracisi: eskisi gibi uzar
    const smxEposta = `${ON.toLowerCase()}smxk${uuid().slice(0, 5)}@ornek.test`;
    const sk = await kiraciKur({ ad: 'SMX Kiraci', tier: 'TIER_SOFRAMIX', parent: 'SofraMix', eposta: smxEposta });
    const sK = await P.odemeIsle(odeme({ isletme_adi: `${ON} SMX Kiraci`, yetkili_email: smxEposta }));
    ok('SofraMix kiracisi e-postayla: islendi (eski davranis)', sK.durum === 'islendi' && sK.tenantId === sk && sK.esles === 'eposta', sK);
    // R1-L2: POS'tan kayit olan (deneme_kayitlari kaynak 'kayit', telefonlu) YEREL isletme; SofraMix odemesi ayni telefonla
    const yTel = '0532 ' + String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7);
    const yt = await kiraciKur({ ad: 'Yerel Tel', tier: 'TIER_6_10', limit: 10, moduller: ['BASE', 'MENU_DIGITAL'] });
    await query(`INSERT INTO deneme_kayitlari (id, tenant_id, telefon_norm, soframix_business_id, isletme_adi, kaynak, bitis)
                 VALUES (?, ?, ?, NULL, ?, 'kayit', ?)`, [uuid(), yt, P.telefonNorm(yTel), `${ON} Yerel Tel`, gun(5)]);
    const ytOnce = await kiraci(yt);
    const oYT = odeme({ business_id: smxNo(), isletme_adi: `${ON} Yerel Tel SMX`, yetkili_tel: yTel, yetkili_email: `${ON.toLowerCase()}yt${uuid().slice(0, 5)}@ornek.test`, pos_paket: tam });
    const sYT = await P.odemeIsle(oYT);
    ok('telefonla eslesen yerel isletme -> elde yerel_tel, aday = yerel isletme', sYT.durum === 'elde' && sYT.sebep === 'yerel_tel' && sYT.adayTenantId === yt, sYT);
    const ytSonra = await kiraci(yt);
    ok('yerel isletme (telefon) sessizce cevrilmedi', ytSonra.parent_org == null && ytSonra.license_tier === 'TIER_6_10'
        && ytSonra.license_end_date === ytOnce.license_end_date && ytSonra.license_modules === ytOnce.license_modules, ytSonra);
    const rYT = await cevap({ odemeId: oYT.odeme_id }, { islem: 'yeni' });
    ok('root "Yeni işletme olarak aç" -> ayri isletme', rYT.govde && rYT.govde.durum === 'islendi' && rYT.govde.kiraciAcildi && rYT.govde.tenantId !== yt, rYT);
    // SofraMix kaynakli deneme (telefonla) eskisi gibi uzar
    const smxTel = '0534 ' + String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7);
    const st = await kiraciKur({ ad: 'SMX Tel', tel: smxTel, parent: 'SofraMix' });
    const sST = await P.odemeIsle(odeme({ isletme_adi: `${ON} SMX Tel`, yetkili_tel: smxTel, yetkili_email: `${ON.toLowerCase()}st${uuid().slice(0, 5)}@ornek.test` }));
    ok('SofraMix denemesi telefonla: islendi (deneme_tel)', sST.durum === 'islendi' && sST.tenantId === st && sST.esles === 'deneme_tel', sST);

    console.log('\n=== 8) GET /api/public/soframix-durum ===');
    const rd = await al(durumAdresi(durumGovde(no7)));
    ok('200 bulundu', rd.status === 200 && rd.d && rd.d.bulundu === true, rd);
    ok('alanlar tam', rd.d && JSON.stringify(Object.keys(rd.d).sort()) === JSON.stringify(['bekleyenOdeme', 'bulundu', 'durum', 'isletme_no', 'kalanGun', 'kanal', 'lisansBitis', 'paket']), rd.d && Object.keys(rd.d));
    ok('isletme_no sayi, durum AKTIF, kanal soframix', rd.d.isletme_no === Number(no7) && rd.d.durum === 'AKTIF' && rd.d.kanal === 'soframix', rd.d);
    ok('paket ozel TIER_1_5', rd.d.paket && rd.d.paket.tur === 'ozel' && rd.d.paket.tier === 'TIER_1_5' && rd.d.paket.moduller.includes('GARSON'), rd.d.paket);
    ok('lisansBitis ISO, kalanGun > 360', /^\d{4}-\d{2}-\d{2}T/.test(rd.d.lisansBitis) && rd.d.kalanGun > 360, rd.d);
    ok('no-store', /no-store/.test(rd.cache || ''), rd.cache);
    ok('kisisel veri yok', !/@|ornek|05\d\d/.test(JSON.stringify(rd.d)));
    const rtam = await al(durumAdresi(durumGovde(no8)));
    ok('tam paket kiracisi: tur tam', rtam.d && rtam.d.paket.tur === 'tam' && rtam.d.paket.tier === null, rtam.d);
    const no9 = smxNo();
    await kiraciKur({ ad: 'Deneme Durum', smx: no9, parent: 'SofraMix' });
    const rden = await al(durumAdresi(durumGovde(no9)));
    ok('deneme kiracisi: tur deneme', rden.d && rden.d.paket.tur === 'deneme', rden.d);
    // bekleyen (elde) odeme: denemedeki isletmenin SofraMix odemesi tutar farkiyla elde kaldi
    const no10 = smxNo();
    await kiraciKur({ ad: 'Deneme Bekleyen', smx: no10, parent: 'SofraMix' });
    const s10 = await P.odemeIsle(odeme({ business_id: no10, isletme_adi: ON + ' Deneme Bekleyen', pos_paket: { ...tam, smxTutarKurus: 100 } }));
    const rbek = await al(durumAdresi(durumGovde(no10)));
    ok('elde odemesi olan isletme: bekleyenOdeme true, paket hala deneme', s10.durum === 'elde' && rbek.d && rbek.d.bulundu && rbek.d.bekleyenOdeme === true && rbek.d.paket.tur === 'deneme', rbek.d);
    const yok = await al(durumAdresi(durumGovde(smxNo())));
    ok('bilinmeyen isletme: { bulundu: false }', yok.status === 200 && JSON.stringify(yok.d) === '{"bulundu":false}', yok.d);
    ok('B subesi kendi numarasiyla kendi kiracisini bulur', (await al(durumAdresi(durumGovde(noB)))).d.bulundu === true);
    const yanlis = await al(durumAdresi(durumGovde(no7), 'baska-gizli-anahtar-1234567890'));
    ok('yanlis imza 401', yanlis.status === 401, yanlis);
    const bozuk = await al(`/api/public/soframix-durum?yuk=abc&imza=xyz`);
    ok('bozuk imza bicimi 401', bozuk.status === 401, bozuk.status);
    const eski = await al(durumAdresi(durumGovde(no7, { zaman: Math.floor(Date.now() / 1000) - 400 })));
    ok('300 sn den eski 410', eski.status === 410, eski.status);
    const ileri = await al(durumAdresi(durumGovde(no7, { zaman: Math.floor(Date.now() / 1000) + 120 })));
    ok('60 sn den ileri 410', ileri.status === 410, ileri.status);
    const amac = await al(durumAdresi(durumGovde(no7, { amac: 'deneme' })));
    ok('yanlis amac 400', amac.status === 400, amac.status);
    const kapaliR = await al(durumAdresi(durumGovde(no7)), PORT_KAPALI);
    ok('gizli anahtar yoksa 503', kapaliR.status === 503, kapaliR.status);

    console.log('\n=== 9) Lisans sayfasi paket bilgisi ===');
    const bilgi = await SP.kiraciPaketBilgisi(d7);
    ok('kiraciPaketBilgisi: ozel, kademe adi, modul adlari', bilgi && bilgi.tur === 'ozel' && bilgi.tierAd === '1-5 Masa' && bilgi.modulAdlari.includes('Garson') && bilgi.masaSiniri === 5, bilgi);

    await temizle();
    await katalogGeriYaz();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => {
    console.error(e);
    try { await temizle(); await katalogGeriYaz(); } catch (_) {}
    process.exit(1);
});
