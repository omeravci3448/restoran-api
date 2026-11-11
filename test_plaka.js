// Masa plakasi (C): hediye hakki matrisi (deneme / onayli yillik / eski kayit / provizyon / elle ver-kaldir /
// kurala uymayan paket ucretli), hediye kurallari (moduller, en az tutar, en cok plaka, aktif/pasif, birden cok
// kural, CRUD + yetki, maliyet onizlemesi), 1 set kurali, ucretli ayrim ve tutar, durum gecisleri ve yetkiler
// (isletme / root / yetkisiz), iptal kurallari, odeme bildirimi + root olaylari, onizleme yerlesimi, masa silme
// uyarisi, baski PDF'i (gecerli PDF, sayfa = plaka + kapak, gomulu yazi tipi) ve toplu karekod PDF'i.
// Sunucuyu KENDI baslatir.  Calistir: node test_plaka.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 46122, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'plaka-test-jwt';
const ON = 'PLKT Test';
const EPOSTA_ON = 'plkt-';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function ikili(yol, token) {
    const r = await fetch(TABAN + yol, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, tur: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) };
}
// PDF sayfa sayisi: "/Type /Page" (Pages haric)
const sayfaSay = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;

// Kucuk PNG kodlayici (RGBA, filtresiz): baski icin yeterli buyuklukte test logosu
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function parca(tur, veri) {
    const u = Buffer.alloc(4); u.writeUInt32BE(veri.length);
    const tv = Buffer.concat([Buffer.from(tur, 'ascii'), veri]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(tv));
    return Buffer.concat([u, tv, c]);
}
function png(gen, yuk) {
    const ham = Buffer.alloc((gen * 4 + 1) * yuk);
    for (let y = 0; y < yuk; y++) for (let x = 0; x < gen; x++) {
        const o = y * (gen * 4 + 1) + 1 + x * 4;
        const ic = x > gen * 0.05 && x < gen * 0.95 && y > yuk * 0.15 && y < yuk * 0.85;
        ham[o] = 226; ham[o + 1] = 98; ham[o + 2] = 42; ham[o + 3] = ic ? 255 : 0;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(gen, 0); ihdr.writeUInt32BE(yuk, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), parca('IHDR', ihdr), parca('IDAT', zlib.deflateSync(ham)), parca('IEND', Buffer.alloc(0))]);
}
const PNG_BUYUK = 'data:image/png;base64,' + png(900, 300).toString('base64');
const PNG_KUCUK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const GELECEK = new Date(Date.now() + 200 * 86400000).toISOString();
const TAM = ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'];
async function kiraciKur({ ad, moduller = TAM, tier = 'TIER_20_PLUS', masa = 0 }) {
    const id = uuid();
    const slug = 'plkt-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '0532 111 22 33', 'Cumhuriyet Mah. Atatürk Cad. No: 5 Afyonkarahisar',
            tier, JSON.stringify(moduller), GELECEK]);
    const kul = {};
    for (const [rol, sifre] of [['OWNER', 'sahip1234'], ['MANAGER', 'mudur1234'], ['CASHIER', 'kasa1234']]) {
        const uid = uuid();
        const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
        await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uid, id, eposta, await bcrypt.hash(sifre, 4), rol, rol, new Date().toISOString()]);
        kul[rol] = { eposta, sifre };
    }
    for (let i = 1; i <= masa; i++) {
        await query('INSERT INTO tables (id, tenant_id, code, name, section, qr_token) VALUES (?, ?, ?, ?, ?, ?)',
            [uuid(), id, 'M' + i, 'Masa ' + i, i <= 3 ? 'Bahçe' : 'Salon', crypto.randomBytes(16).toString('hex')]);
    }
    const jet = {};
    for (const rol of Object.keys(kul)) {
        jet[rol] = (await js('/api/auth/login', { body: { email: kul[rol].eposta, businessCode: kod, password: kul[rol].sifre } })).d.token;
    }
    return { id, slug, kod, jet };
}
async function odemeEkle(tenantId, { tier = 'TIER_6_10', onayGun = 365, donemGun = null, durum = 'onaylandi' } = {}) {
    const id = uuid();
    const bitis = new Date(Date.now() + (donemGun || onayGun || 365) * 86400000).toISOString();
    await query(
        `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
         VALUES (?, ?, ?, '[]', 1000, ?, ?, datetime('now'), ?)`, [id, tenantId, tier, durum, bitis, onayGun]);
    return id;
}

let rootId = null;
async function rootJeton() {
    if (!rootId) {
        rootId = uuid();
        await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
            [rootId, `${EPOSTA_ON}root-${rootId.slice(0, 6)}@ornek.test`, 'x', 'Test Root']);
    }
    return jwt.sign({ rootId, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' });
}

const AYARLAR = ['plaka_birim_fiyat', 'plaka_kargo_ucreti', 'plaka_olcu', 'plaka_maliyet_birim', 'plaka_maliyet_kargo'];
let kuralYedek = null;
let ayarYedek = null;
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%'`);
    const { UPLOADS_DIR } = require('./src/services/imageService');
    for (const r of t.rows) {
        for (const tb of ['plaka_talepleri', 'lisans_odemeleri', 'pos_provizyon', 'root_olaylar', 'tables', 'license_cache', 'islem_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
        try { fs.rmSync(path.join(UPLOADS_DIR, r.id), { recursive: true, force: true }); } catch (_) {}
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (kuralYedek) {
        await query('DELETE FROM plaka_hediye_kurallari');
        for (const k of kuralYedek) {
            await query(`INSERT INTO plaka_hediye_kurallari (id, ad, moduller, en_az_tutar, en_cok_plaka, aktif, sira, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [k.id, k.ad, k.moduller, k.en_az_tutar, k.en_cok_plaka, k.aktif, k.sira, k.created_at, k.updated_at]);
        }
    }
    if (ayarYedek) {
        for (const a of AYARLAR) {
            if (ayarYedek[a] === undefined) await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [a]);
            else await query('UPDATE sistem_ayarlari SET deger = ? WHERE anahtar = ?', [ayarYedek[a], a]);
        }
    }
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    kuralYedek = (await query('SELECT * FROM plaka_hediye_kurallari')).rows;
    // Test varsayilan kuraldan baslar: Adisyon ve Kasa + QR Menu, tutar siniri yok, en cok 25
    await query('DELETE FROM plaka_hediye_kurallari');
    await query(`INSERT INTO plaka_hediye_kurallari (id, ad, moduller, en_az_tutar, en_cok_plaka, aktif, sira)
                 VALUES ('varsayilan', 'Adisyon ve Kasa + QR Menü', '["BASE","MENU_DIGITAL"]', NULL, 25, 1, 10)`);
    ayarYedek = {};
    for (const a of AYARLAR) {
        const r = await query('SELECT deger FROM sistem_ayarlari WHERE anahtar = ?', [a]);
        ayarYedek[a] = r.rows.length ? r.rows[0].deger : undefined;
        await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [a]);   // test varsayilanlardan baslar
    }
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const hak = async (tid) => (await js('/api/root/plaka/hak/' + tid, { token: rj })).d;

    console.log('=== 1) Hediye hakki matrisi ===');
    const deneme = await kiraciKur({ ad: 'Deneme', tier: 'TIER_DENEME', masa: 4 });
    const h0 = await hak(deneme.id);
    ok('deneme (odeme yok): hak yok, durum YILLIK_PAKETTE', h0.hak === false && h0.durum === 'YILLIK_PAKETTE' && h0.adet === 0, h0);
    await odemeEkle(deneme.id, { durum: 'beklemede' });
    ok('bekleyen (onaysiz) odeme hak vermez', (await hak(deneme.id)).hak === false);
    const yillik = await kiraciKur({ ad: 'Yıllık', masa: 30 });
    await odemeEkle(yillik.id, { onayGun: 365 });
    const h1 = await hak(yillik.id);
    ok('onayli yillik odeme: VAR, kaynak yillik_odeme, adet = en cok 25', h1.durum === 'VAR' && h1.kaynak === 'yillik_odeme' && h1.adet === 25 && h1.aktifMasa === 30, h1);
    const aylik = await kiraciKur({ ad: 'Aylık', masa: 3 });
    await odemeEkle(aylik.id, { onayGun: 30 });
    ok('30 gunluk onay hak vermez', (await hak(aylik.id)).hak === false);
    const eski = await kiraciKur({ ad: 'Eski Kayıt', masa: 3 });
    await odemeEkle(eski.id, { onayGun: null, donemGun: 365 });
    const h2 = await hak(eski.id);
    ok('eski kayit (onay_gun yok, donem 365 gun): VAR, adet = masa sayisi (3)', h2.durum === 'VAR' && h2.adet === 3, h2);
    const eski30 = await kiraciKur({ ad: 'Eski Kısa', masa: 3 });
    await odemeEkle(eski30.id, { onayGun: null, donemGun: 30 });
    ok('eski kayit 30 gun: hak yok', (await hak(eski30.id)).hak === false);
    const smx = await kiraciKur({ ad: 'SofraMix', tier: 'TIER_SOFRAMIX', masa: 2 });
    await query(`INSERT INTO pos_provizyon (id, odeme_id, tenant_id, tutar_kurus, durum) VALUES (?, ?, ?, 0, 'islendi')`, [uuid(), 'plkt-' + uuid(), smx.id]);
    ok('provizyon tutari 0: hak yok', (await hak(smx.id)).hak === false);
    await query(`INSERT INTO pos_provizyon (id, odeme_id, tenant_id, tutar_kurus, durum) VALUES (?, ?, ?, 1200000, 'islendi')`, [uuid(), 'plkt-' + uuid(), smx.id]);
    const h3 = await hak(smx.id);
    ok('SofraMix yillik provizyon (tutar > 0): VAR, kaynak soframix', h3.durum === 'VAR' && h3.kaynak === 'soframix', h3);
    const qrm = await kiraciKur({ ad: 'Sadece QR', moduller: ['MENU_DIGITAL'], tier: 'TIER_6_10', masa: 3 });
    await odemeEkle(qrm.id, { onayGun: 365 });
    const h4 = await hak(qrm.id);
    ok('yalniz QR Menu (yillik odemesi olsa da): kurala uymaz, KURAL_DISI + ornek kural', h4.hak === false && h4.durum === 'KURAL_DISI'
        && h4.ornekKural && h4.ornekKural.moduller.includes('BASE'), h4);
    ok('root elle ver: deneme isletmeye hak', (await js('/api/root/tenants/' + deneme.id, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: 1 } })).status === 200
        && (await hak(deneme.id)).durum === 'VAR');
    await js('/api/root/tenants/' + yillik.id, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: 0 } });
    ok('root elle kaldir: yillik isletmede KALDIRILDI', (await hak(yillik.id)).durum === 'KALDIRILDI');
    await js('/api/root/tenants/' + yillik.id, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: '' } });
    ok('otomatige donunce tekrar VAR', (await hak(yillik.id)).durum === 'VAR');
    ok('gecersiz elle deger 400', (await js('/api/root/tenants/' + yillik.id, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: 7 } })).status === 400);

    console.log('\n=== 2) Ayarlar ve hediye kurallari ===');
    const a0 = (await js('/api/root/plaka/ayarlar', { token: rj })).d;
    ok('varsayilan ayarlar: fiyat yok, olcu 80x80', a0.birimFiyat === null && a0.olcu === '80x80' && a0.olculer.length === 3, a0);
    const kl0 = (await js('/api/root/plaka/kurallar', { token: rj })).d;
    ok('varsayilan tek kural: BASE + MENU_DIGITAL, en cok 25, aktif', kl0.kurallar.length === 1 && JSON.stringify(kl0.kurallar[0].moduller) === '["BASE","MENU_DIGITAL"]'
        && kl0.kurallar[0].enCokPlaka === 25 && kl0.kurallar[0].aktif && kl0.moduller.some((m) => m.kod === 'QR_SIPARIS'), kl0);
    const a1 = await js('/api/root/plaka/kurallar/varsayilan', { token: rj, method: 'PATCH', body: { enCokPlaka: 10 } });
    ok('kuralin en cok plakasi 10 -> yillik isletme adet 10', a1.status === 200 && (await hak(yillik.id)).adet === 10, a1.d);
    await js('/api/root/plaka/kurallar/varsayilan', { token: rj, method: 'PATCH', body: { enCokPlaka: 25 } });
    ok('gecersiz en cok plaka 400', (await js('/api/root/plaka/kurallar/varsayilan', { token: rj, method: 'PATCH', body: { enCokPlaka: 0 } })).status === 400);
    ok('modulsuz kural 400', (await js('/api/root/plaka/kurallar', { token: rj, body: { ad: 'Boş', moduller: [] } })).status === 400);
    // Kural matrisi: en az tutar + ikinci kural (yalniz QR Menu) + pasif kural
    await query("UPDATE lisans_odemeleri SET tutar = 1000 WHERE tenant_id = ?", [yillik.id]);
    await js('/api/root/plaka/kurallar/varsayilan', { token: rj, method: 'PATCH', body: { enAzTutar: 5000 } });
    ok('en az tutar 5000, odeme 1000: kural disi', (await hak(yillik.id)).durum === 'KURAL_DISI');
    await query("UPDATE lisans_odemeleri SET tutar = 6000 WHERE tenant_id = ?", [yillik.id]);
    ok('odeme 6000: tekrar VAR', (await hak(yillik.id)).durum === 'VAR');
    // Yukseltme kaydi: odenen tutar kucuk (kredi dusuldu) ama donemin yillik degeri yeni_toplam
    await query("UPDATE lisans_odemeleri SET tutar = 800, yeni_toplam = 6300, tur = 'yukseltme' WHERE tenant_id = ?", [yillik.id]);
    ok('yukseltme kaydi (odenen 800, yillik deger 6300): en az tutar yillik degere bakar, VAR', (await hak(yillik.id)).durum === 'VAR');
    await query("UPDATE lisans_odemeleri SET tutar = 6000, yeni_toplam = NULL, tur = NULL WHERE tenant_id = ?", [yillik.id]);
    await js('/api/root/plaka/kurallar/varsayilan', { token: rj, method: 'PATCH', body: { enAzTutar: '' } });
    const k2 = await js('/api/root/plaka/kurallar', { token: rj, body: { ad: 'Yalnız QR Menü', moduller: ['MENU_DIGITAL'], enCokPlaka: 5, aktif: true } });
    ok('ikinci kural eklendi (201)', k2.status === 201 && k2.d.enCokPlaka === 5, k2);
    const hk2 = await hak(qrm.id);
    ok('yalniz QR Menu isletmesi ikinci kurala uyar: VAR, en cok 5 (3 masa -> 3)', hk2.durum === 'VAR' && hk2.adet === 3 && hk2.kural.id === k2.d.id, hk2);
    ok('iki kurala uyan isletmede en buyuk sinir gecer (25)', (await hak(yillik.id)).ustSinir === 25);
    await js('/api/root/plaka/kurallar/' + k2.d.id, { token: rj, method: 'PATCH', body: { aktif: false } });
    ok('kural pasif: yalniz QR Menu isletmesi yine KURAL_DISI', (await hak(qrm.id)).durum === 'KURAL_DISI');
    ok('deneme isletmesi kurala uysa da hak yok (yillik odeme yok)', (await js('/api/root/tenants/' + deneme.id, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: '' } })).status === 200
        && (await hak(deneme.id)).durum === 'YILLIK_PAKETTE');
    await js('/api/root/plaka/ayarlar', { token: rj, method: 'PUT', body: { maliyetBirim: 120, maliyetKargo: 80 } });
    const onzl = (await js('/api/root/plaka/kurallar/onizleme', { token: rj })).d;
    const onV = onzl.kurallar.find((k) => k.id === 'varsayilan');
    ok('maliyet onizlemesi: kayitli girdiler (120 + 80), varsayilan kurala uyanlar sayilir', onzl.birimMaliyet === 120 && onzl.kargoMaliyet === 80 && onV.uyanIsletme >= 3, onzl);
    const onQ = (await js('/api/root/plaka/kurallar/onizleme?birimMaliyet=100&kargoMaliyet=50', { token: rj })).d;
    const k2O = onQ.kurallar.find((k) => k.id === k2.d.id);
    ok('ikinci kural onizlemesi: uyan isletmeler, ortalama masa, maliyet ve odeme yuzdesi', k2O.uyanIsletme >= 1
        && (k2O.uyanIsletme > 1 || (k2O.ortalamaMasa === 3 && k2O.ortalamaMaliyet === 350 && k2O.yuzde === 35)), k2O);
    ok('gecersiz maliyet 400', (await js('/api/root/plaka/kurallar/onizleme?birimMaliyet=-1', { token: rj })).status === 400);
    ok('kural silinir (200), olmayan 404', (await js('/api/root/plaka/kurallar/' + k2.d.id, { token: rj, method: 'DELETE' })).status === 200
        && (await js('/api/root/plaka/kurallar/' + k2.d.id, { token: rj, method: 'DELETE' })).status === 404);
    ok('kiraci jetonu kurallara giremez (403)', (await js('/api/root/plaka/kurallar', { token: yillik.jet.OWNER })).status === 403);
    ok('gecersiz olcu 400', (await js('/api/root/plaka/ayarlar', { token: rj, method: 'PUT', body: { olcu: '50x50' } })).status === 400);
    ok('negatif fiyat 400', (await js('/api/root/plaka/ayarlar', { token: rj, method: 'PUT', body: { birimFiyat: -5 } })).status === 400);
    ok('kiraci jetonu root ayarina giremez (403)', (await js('/api/root/plaka/ayarlar', { token: yillik.jet.OWNER })).status === 403);
    ok('jetonsuz root ucu 401', (await js('/api/root/plaka/talepler')).status === 401);

    console.log('\n=== 3) Isletme durumu ve onizleme ===');
    const Y = yillik.jet.OWNER;
    const d0 = (await js('/api/plaka/durum', { token: Y })).d;
    ok('durum: hediye VAR 25, ucretli kapali, 30 aktif masa (8 haneli kisa kodlu)', d0.hediye.durum === 'VAR' && d0.hediye.adet === 25 && d0.fiyat.ucretliAcik === false
        && d0.masalar.length === 30 && d0.masalar.every((m) => /^[A-Z0-9]{8}$/.test(m.kisaKod)), { h: d0.hediye, f: d0.fiyat, n: d0.masalar.length });
    ok('durum: logo yok, isletme bilgisi on dolu', d0.logo.var === false && d0.isletme.telefon === '0532 111 22 33' && /Atatürk/.test(d0.isletme.adres), d0.logo);
    ok('kasiyer plaka sayfasina giremez (403)', (await js('/api/plaka/durum', { token: yillik.jet.CASHIER })).status === 403);
    ok('mudur girebilir (200)', (await js('/api/plaka/durum', { token: yillik.jet.MANAGER })).status === 200);
    ok('jetonsuz 401', (await js('/api/plaka/durum')).status === 401);
    const masa1 = d0.masalar[0];
    const on = (await js('/api/plaka/onizleme?tableId=' + masa1.id, { token: Y })).d;
    const qrO = on.ogeler.find((o) => o.tur === 'qr');
    const metin = on.ogeler.filter((o) => o.tur === 'metin').map((o) => o.metin);
    ok('onizleme: 80x80, kose 4, karekod 42 mm, yol var', on.genislik === 80 && on.yukseklik === 80 && on.koseYaricap === 4 && qrO && qrO.boyut === 42 && qrO.d.startsWith('M'), { g: on.genislik, q: qrO && qrO.boyut });
    ok('onizleme: masa adi + "Menü ve sipariş için okutun" + mdayazilim.com (logo yok -> isletme adi)', metin.includes(masa1.ad) && metin.includes('Menü ve sipariş için okutun')
        && metin.includes('mdayazilim.com') && metin.some((m) => /PLKT Test/.test(m)), metin);
    ok('onizleme adresi kisa kod', on.adres === 'https://restoran.mdayazilim.com/q/' + masa1.kisaKod && on.kisaKod === masa1.kisaKod, on.adres);
    await query('UPDATE tenants SET qr_siparis_acik = 0 WHERE id = ?', [yillik.id]);
    const on2 = (await js('/api/plaka/onizleme?tableId=' + masa1.id + '&olcu=100x70', { token: Y })).d;
    ok('siparis kapaliyken "Menü için okutun"; 100x70 yatay', on2.genislik === 100 && on2.yukseklik === 70 && on2.ogeler.some((o) => o.metin === 'Menü için okutun'), on2.genislik);
    await query('UPDATE tenants SET qr_siparis_acik = 1 WHERE id = ?', [yillik.id]);
    ok('baska isletmenin masasi onizlenemez (404)', (await js('/api/plaka/onizleme?tableId=' + masa1.id, { token: eski.jet.OWNER })).status === 404);

    console.log('\n=== 4) Talep: logo, hediye, ucretli ===');
    const tum = d0.masalar.map((m) => m.id);
    const teslimat = { aliciAd: 'Ayşe Yılmaz', telefon: '0532 111 22 33', adres: 'Cumhuriyet Mah. Atatürk Cad. No: 5 Afyonkarahisar', not: 'Öğleden sonra' };
    const t0 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum.slice(0, 5), ...teslimat } });
    ok('logo yokken 409 LOGO_YOK', t0.status === 409 && t0.d.code === 'LOGO_YOK', t0);
    await js('/api/tenant/me', { token: Y, method: 'PUT', body: { logoUrl: PNG_KUCUK } });
    const d1 = (await js('/api/plaka/durum', { token: Y })).d;
    ok('kucuk logo: uyari var ama uygun', d1.logo.var && d1.logo.uygun && /daha büyük logo/.test(d1.logo.uyari || ''), d1.logo);
    await js('/api/tenant/me', { token: Y, method: 'PUT', body: { logoUrl: PNG_BUYUK } });
    const d2 = (await js('/api/plaka/durum', { token: Y })).d;
    ok('buyuk logo (900 px): uyari yok', d2.logo.uygun && !d2.logo.uyari && d2.logo.uzunKenar === 900, d2.logo);
    ok('eksik alici adi 400', (await js('/api/plaka/talepler', { token: Y, body: { ...teslimat, aliciAd: '', tableIds: tum.slice(0, 2) } })).status === 400);
    ok('eksik adres 400', (await js('/api/plaka/talepler', { token: Y, body: { ...teslimat, adres: 'kısa', tableIds: tum.slice(0, 2) } })).status === 400);
    ok('masa secilmeden 400', (await js('/api/plaka/talepler', { token: Y, body: { ...teslimat, tableIds: [] } })).status === 400);
    ok('baska isletmenin masasi 400', (await js('/api/plaka/talepler', { token: Y, body: { ...teslimat, tableIds: [tum[0], 'yok-' + uuid()] } })).status === 400);
    const t1 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum, ...teslimat } });
    ok('fiyat yokken hediye ustu secim 409 UCRETLI_KAPALI (iletisim mesaji)', t1.status === 409 && t1.d.code === 'UCRETLI_KAPALI' && /iletişime geçin/.test(t1.d.message), t1);
    const t2 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum.slice(0, 5), ...teslimat } });
    ok('hediye talebi 201: ALINDI, 5 hediye, tutar 0', t2.status === 201 && t2.d.durum === 'ALINDI' && t2.d.hediye_adet === 5 && t2.d.ucretli_adet === 0 && t2.d.tutar === 0, t2.d);
    ok('talepte masa kopyasi (ad + kisa kod + hediye)', t2.d.masalar.length === 5 && t2.d.masalar.every((m) => m.kisaKod && m.ad && m.hediye === true), t2.d.masalar && t2.d.masalar[0]);
    ok('talep no 1000 ustu', t2.d.talep_no > 1000, t2.d.talep_no);
    ok('isletme root notunu gormez', !('root_not' in t2.d));
    const h5 = (await js('/api/plaka/durum', { token: Y })).d.hediye;
    ok('hediye KULLANILDI (talep no + tarih)', h5.durum === 'KULLANILDI' && h5.kullanildi && h5.kullanildi.talepNo === t2.d.talep_no, h5);
    const t3 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum.slice(5, 7), ...teslimat } });
    ok('1 set: ikinci talepte hediye yok -> fiyat yokken 409', t3.status === 409 && t3.d.code === 'UCRETLI_KAPALI', t3);
    await js('/api/root/plaka/ayarlar', { token: rj, method: 'PUT', body: { birimFiyat: 150, kargoUcreti: 50 } });
    const t4 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum.slice(5, 7), ...teslimat } });
    ok('ucretli talep 201: ODEME_BEKLENIYOR, 2 x 150 + 50 kargo = 350', t4.status === 201 && t4.d.durum === 'ODEME_BEKLENIYOR' && t4.d.ucretli_adet === 2
        && t4.d.hediye_adet === 0 && t4.d.tutar === 350 && t4.d.birim_fiyat === 150 && t4.d.kargo_ucreti === 50, t4.d);

    console.log('\n=== 5) Iptal kurallari ve hakkin geri donmesi ===');
    const ip1 = await js(`/api/plaka/talepler/${t2.d.id}/iptal`, { token: Y, method: 'POST' });
    ok('Alindi iken isletme iptal eder (200, IPTAL)', ip1.status === 200 && ip1.d.durum === 'IPTAL', ip1);
    ok('iptal edilen hediye hakki geri verir (VAR)', (await js('/api/plaka/durum', { token: Y })).d.hediye.durum === 'VAR');
    ok('iptal edilmis talep tekrar iptal edilemez (409)', (await js(`/api/plaka/talepler/${t2.d.id}/iptal`, { token: Y, method: 'POST' })).status === 409);
    const t5 = await js('/api/plaka/talepler', { token: Y, body: { tableIds: tum, ...teslimat } });
    ok('30 masa: 25 hediye + 5 ucretli = 5 x 150 + 50 = 800, ODEME_BEKLENIYOR', t5.status === 201 && t5.d.hediye_adet === 25 && t5.d.ucretli_adet === 5
        && t5.d.tutar === 800 && t5.d.durum === 'ODEME_BEKLENIYOR' && t5.d.masalar.filter((m) => m.hediye).length === 25, t5.d);
    ok('baska isletme bu talebi iptal edemez (404)', (await js(`/api/plaka/talepler/${t5.d.id}/iptal`, { token: eski.jet.OWNER, method: 'POST' })).status === 404);
    ok('kasiyer iptal edemez (403)', (await js(`/api/plaka/talepler/${t5.d.id}/iptal`, { token: yillik.jet.CASHIER, method: 'POST' })).status === 403);

    console.log('\n=== 6) Odeme bildirimi, root olaylari, sayac ===');
    const od = await js(`/api/plaka/talepler/${t5.d.id}/odeme`, { token: Y, body: { ref: 'Havale 1234' } });
    ok('"Odemeyi yaptim" 200', od.status === 200 && !!od.d.odeme_bildirildi_at && od.d.odeme_ref === 'Havale 1234', od.d);
    ok('ikinci bildirim 409', (await js(`/api/plaka/talepler/${t5.d.id}/odeme`, { token: Y, body: {} })).status === 409);
    const ipOd = await js(`/api/plaka/talepler/${t5.d.id}/iptal`, { token: Y, method: 'POST' });
    ok('O3: odemesi bildirilen talebi isletme iptal edemez (409 ODEME_BILDIRILDI)', ipOd.status === 409 && ipOd.d.code === 'ODEME_BILDIRILDI', ipOd);
    ok('hediye talebinde odeme bildirimi 409', (await js(`/api/plaka/talepler/${t2.d.id}/odeme`, { token: Y, body: {} })).status === 409);
    const ol = (await query("SELECT tur, ref, detay FROM root_olaylar WHERE tenant_id = ? ORDER BY id", [yillik.id])).rows;
    ok('root olaylari: plaka_talebi (3) + plaka_odeme (1)', ol.filter((x) => x.tur === 'plaka_talebi').length === 3 && ol.filter((x) => x.tur === 'plaka_odeme').length === 1
        && ol.some((x) => /Masa plakası talebi/.test(x.detay)), ol);
    const ilkOlay = Math.min(...(await query("SELECT id FROM root_olaylar WHERE tenant_id = ? AND tur LIKE 'plaka_%'", [yillik.id])).rows.map((x) => x.id));
    const oz = await require('./src/services/yeniKayitIzleyici').telefonOzeti(ilkOlay - 1);
    ok('yonetim APK ozeti: plaka olaylari sayilir, son olay turuyla doner', oz.yeni >= 4 && oz.son && typeof oz.son.tur === 'string' && oz.sonId >= ilkOlay, oz);
    const sy = (await js('/api/root/plaka/sayac', { token: rj })).d;
    ok('root sayac: islem bekleyen >= 1', sy.bekleyen >= 1, sy);

    console.log('\n=== 7) Root durum gecisleri ===');
    const rd = (id, govde) => js(`/api/root/plaka/talepler/${id}/durum`, { token: rj, body: govde });
    ok('odemesi alinmadan hazirlanamaz (409)', (await rd(t5.d.id, { islem: 'hazirlaniyor' })).status === 409);
    ok('odemesi alinmadan kargoya verilemez (409)', (await rd(t5.d.id, { islem: 'kargoda', kargoFirma: 'Aras', takipNo: '123456' })).status === 409);
    ok('gecersiz islem 400', (await rd(t5.d.id, { islem: 'uc' })).status === 400);
    const g1 = await rd(t5.d.id, { islem: 'odeme_alindi' });
    ok('odeme alindi -> ODEME_ALINDI', g1.status === 200 && g1.d.durum === 'ODEME_ALINDI' && !!g1.d.odeme_alindi_at, g1.d && g1.d.durum);
    ok('ODEME_ALINDI iken isletme iptal edemez (409)', (await js(`/api/plaka/talepler/${t5.d.id}/iptal`, { token: Y, method: 'POST' })).status === 409);
    const g2 = await rd(t5.d.id, { islem: 'hazirlaniyor' });
    ok('hazirlaniyor', g2.status === 200 && g2.d.durum === 'HAZIRLANIYOR');
    const ms = (await js('/api/tables', { token: Y })).d;
    ok('masa listesi: plakasi basilan masalar isaretli (silme uyarisi)', ms.filter((m) => m.plaka_basildi === 1).length === 30, ms.filter((m) => m.plaka_basildi).length);
    ok('kargo firmasi olmadan 400', (await rd(t5.d.id, { islem: 'kargoda' })).status === 400);
    const g3 = await rd(t5.d.id, { islem: 'kargoda', kargoFirma: 'Aras Kargo', takipNo: 'AR123456789' });
    ok('kargoya verildi (firma + takip no)', g3.status === 200 && g3.d.durum === 'KARGODA' && g3.d.kargo_firma === 'Aras Kargo' && g3.d.takip_no === 'AR123456789', g3.d);
    ok('kargodayken red edilemez (409)', (await rd(t5.d.id, { islem: 'reddet', sebep: 'deneme' })).status === 409);
    const g4 = await rd(t5.d.id, { islem: 'teslim' });
    ok('teslim edildi', g4.status === 200 && g4.d.durum === 'TESLIM_EDILDI' && !!g4.d.teslim_at);
    ok('teslimden sonra gecis yok (409)', (await rd(t5.d.id, { islem: 'teslim' })).status === 409);
    ok('root notu yazilir', (await js(`/api/root/plaka/talepler/${t5.d.id}/not`, { token: rj, body: { not: 'Matbaa: 14 Kasım' } })).d.root_not === 'Matbaa: 14 Kasım');
    const isl = (await js('/api/plaka/talepler', { token: Y })).d;
    ok('isletme listesi: durumlar + root notu YOK', isl.length === 3 && isl.every((x) => !('root_not' in x)) && isl.some((x) => x.durum === 'TESLIM_EDILDI' && x.kargo_firma === 'Aras Kargo'), isl.map((x) => x.durum));
    // Red: sebep zorunlu, isletme gorur
    ok('red sebepsiz 400', (await rd(t4.d.id, { islem: 'reddet' })).status === 400);
    const g5 = await rd(t4.d.id, { islem: 'reddet', sebep: 'Ödeme 7 gün içinde alınamadı.' });
    ok('red -> REDDEDILDI, sebep isletmede gorunur', g5.status === 200 && (await js('/api/plaka/talepler', { token: Y })).d.find((x) => x.id === t4.d.id).red_sebebi === 'Ödeme 7 gün içinde alınamadı.');
    ok('kiraci jetonu root gecisi yapamaz (403)', (await js(`/api/root/plaka/talepler/${t5.d.id}/durum`, { token: Y, body: { islem: 'teslim' } })).status === 403);
    const rl = (await js('/api/root/plaka/talepler?durum=hepsi', { token: rj })).d;
    ok('root listesi: isletme adi + modul kopyasi + kural + masalar', rl.some((x) => x.id === t5.d.id && /PLKT Test/.test(x.business_name) && x.moduller.includes('BASE')
        && x.hediye_kural_ad && x.masalar.length === 30 && x.menu_kipi === false));
    const acik = (await js('/api/root/plaka/talepler', { token: rj })).d;
    ok('varsayilan (acik) filtre teslim edileni gostermez', !acik.some((x) => x.id === t5.d.id));

    console.log('\n=== 8) Hediye talebi reddedilirse hak geri gelir; kurala uymayan paket ucretli ===');
    const e1 = await js('/api/plaka/talepler', { token: eski.jet.OWNER, body: { tableIds: [], ...teslimat } });
    ok('masa secimsiz 400', e1.status === 400);
    await js('/api/tenant/me', { token: eski.jet.OWNER, method: 'PUT', body: { logoUrl: PNG_BUYUK } });
    const ed = (await js('/api/plaka/durum', { token: eski.jet.OWNER })).d;
    const e2 = await js('/api/plaka/talepler', { token: eski.jet.OWNER, body: { tableIds: ed.masalar.map((m) => m.id), ...teslimat } });
    ok('eski kayit isletmesi 3 hediye', e2.status === 201 && e2.d.hediye_adet === 3 && e2.d.durum === 'ALINDI', e2.d);
    await rd(e2.d.id, { islem: 'reddet', sebep: 'Logo baskıya uygun değil, yeniden gönderin.' });
    ok('reddedilen hediye talebi hakki geri verir', (await js('/api/plaka/durum', { token: eski.jet.OWNER })).d.hediye.durum === 'VAR');
    await js('/api/tenant/me', { token: qrm.jet.OWNER, method: 'PUT', body: { logoUrl: PNG_BUYUK } });
    const qd = (await js('/api/plaka/durum', { token: qrm.jet.OWNER })).d;
    ok('yalniz QR Menu: durum KURAL_DISI, alt metin "Menü için okutun", menu kipi', qd.hediye.durum === 'KURAL_DISI' && qd.altMetin === 'Menü için okutun' && qd.menuKipi === true, qd.hediye);
    const q1 = await js('/api/plaka/talepler', { token: qrm.jet.OWNER, body: { tableIds: qd.masalar.map((m) => m.id), ...teslimat } });
    ok('yalniz QR Menu talebi: hepsi ucretli (3 x 150 + 50 = 500), modul kopyasi', q1.status === 201 && q1.d.hediye_adet === 0 && q1.d.ucretli_adet === 3 && q1.d.tutar === 500
        && JSON.parse(q1.d.moduller || '[]').includes('MENU_DIGITAL'), q1.d);

    console.log('\n=== 9) Baski dosyasi ve toplu karekod PDF ===');
    const pdf = await ikili(`/api/root/plaka/talepler/${t5.d.id}/baski.pdf`, rj);
    ok('baski PDF: 200, application/pdf, %PDF basligi', pdf.status === 200 && /application\/pdf/.test(pdf.tur) && pdf.buf.slice(0, 5).toString() === '%PDF-', pdf.status);
    ok('sayfa sayisi = 30 plaka + 1 kapak', sayfaSay(pdf.buf) === 31, sayfaSay(pdf.buf));
    const ham = pdf.buf.toString('latin1');
    ok('Inter yazi tipi gomulu (FontFile2), kesim kutusu (TrimBox/BleedBox) var', /FontFile2/.test(ham) && /Inter/.test(ham) && /TrimBox/.test(ham) && /BleedBox/.test(ham));
    ok('kapakta Turkce karakterler icin ToUnicode eslemesi var', /ToUnicode/.test(ham));
    const p70 = await ikili(`/api/root/plaka/talepler/${q1.d.id}/baski.pdf?olcu=70x70`, rj);
    ok('baski PDF 70x70: 3 plaka + kapak = 4 sayfa', p70.status === 200 && sayfaSay(p70.buf) === 4, sayfaSay(p70.buf));
    ok('kiraci jetonu baski dosyasini indiremez (403)', (await ikili(`/api/root/plaka/talepler/${t5.d.id}/baski.pdf`, Y)).status === 403);
    ok('jetonsuz baski dosyasi 401', (await ikili(`/api/root/plaka/talepler/${t5.d.id}/baski.pdf`)).status === 401);
    const kk = await ikili('/api/tables/karekodlar.pdf', Y);
    ok('toplu karekod PDF: 30 masa / 9 = 4 sayfa', kk.status === 200 && kk.buf.slice(0, 5).toString() === '%PDF-' && sayfaSay(kk.buf) === 4, sayfaSay(kk.buf));
    ok('kasiyer de toplu karekod indirebilir', (await ikili('/api/tables/karekodlar.pdf', yillik.jet.CASHIER)).status === 200);
    const yz = await ikili('/api/public/plaka-yazi/Inter-Bold.ttf');
    ok('onizleme yazi tipi herkese acik (ttf)', yz.status === 200 && yz.buf.length > 100000 && yz.buf.readUInt32BE(0) === 0x00010000, yz.status);
    ok('yazi klasoru disina cikilamaz', (await ikili('/api/public/plaka-yazi/..%2f..%2fconfig%2fdb.js')).status === 404);

    console.log('\n=== 10) Inceleme duzeltmeleri ===');
    // O4: 0 TL onaylanan yillik kayit hediye hakki vermez
    const sifir = await kiraciKur({ ad: 'Sıfır Tutar', masa: 3 });
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 0, 'onaylandi', ?, datetime('now'), 365)`, [uuid(), sifir.id, GELECEK]);
    ok('O4: 0 TL onayli yillik kayit hediye hakki vermez (YILLIK_PAKETTE)', (await hak(sifir.id)).durum === 'YILLIK_PAKETTE');
    // D5: adet = en kucuk(aktif masa, lisans masa siniri, kural)
    const sinirli = await kiraciKur({ ad: 'Masa Sınırlı', masa: 8 });
    await odemeEkle(sinirli.id, { onayGun: 365 });
    await query('UPDATE tenants SET license_table_limit = 5 WHERE id = ?', [sinirli.id]);
    const h5b = await hak(sinirli.id);
    ok('D5: hediye adedi lisans masa siniriyla sinirli (8 masa, sinir 5 -> 5)', h5b.durum === 'VAR' && h5b.adet === 5 && h5b.lisansMasaSiniri === 5, h5b);
    // O6: yonetici sifresi ayarliysa plaka POST uclari sifre ister
    const S = sinirli.jet.OWNER;
    await js('/api/tenant/me', { token: S, method: 'PUT', body: { logoUrl: PNG_BUYUK } });
    await query('UPDATE tenants SET manager_pin = ? WHERE id = ?', [await bcrypt.hash('135790', 4), sinirli.id]);
    const PIN = { 'x-manager-pin': '135790' };
    const sd = (await js('/api/plaka/durum', { token: S })).d;
    const iki = sd.masalar.slice(0, 2).map((m) => m.id);
    const pinSiz = await js('/api/plaka/talepler', { token: S, body: { tableIds: iki, ...teslimat } });
    ok('O6: yonetici sifresi ayarliyken sifresiz talep 403 MANAGER_PIN_REQUIRED', pinSiz.status === 403 && pinSiz.d.code === 'MANAGER_PIN_REQUIRED', pinSiz);
    ok('O6: yanlis sifreyle de 403', (await js('/api/plaka/talepler', { token: S, headers: { 'x-manager-pin': '000000' }, body: { tableIds: iki, ...teslimat } })).status === 403);
    const tp1 = await js('/api/plaka/talepler', { token: S, headers: PIN, body: { tableIds: iki, ...teslimat } });
    ok('O6: sifreyle talep 201 (2 hediye)', tp1.status === 201 && tp1.d.hediye_adet === 2, tp1);
    // D9: cift gonderim
    const tp2 = await js('/api/plaka/talepler', { token: S, headers: PIN, body: { tableIds: iki.slice().reverse(), ...teslimat } });
    ok('D9: ayni masalarla hemen ikinci talep 409 MUKERRER_TALEP (ilk talebin kimligiyle)', tp2.status === 409 && tp2.d.code === 'MUKERRER_TALEP' && tp2.d.id === tp1.d.id, tp2);
    ok('O6: sifresiz iptal 403', (await js(`/api/plaka/talepler/${tp1.d.id}/iptal`, { token: S, method: 'POST' })).status === 403);
    // O5: ALINDI durumundaki talep de silme uyarisi verir
    const msl = (await js('/api/tables', { token: S })).d;
    ok('O5: ALINDI talepteki masalar silme uyarili (plaka_basildi)', msl.filter((m) => m.plaka_basildi === 1).length === 2, msl.map((m) => m.plaka_basildi));
    const silinen = iki[0];
    const sil = await js('/api/tables/' + silinen, { token: S, method: 'DELETE' });
    const rdet = (await js(`/api/root/plaka/talepler/${tp1.d.id}`, { token: rj })).d;
    ok('O5: root ayrintisi silinen masayi isaretler (aktif false, digeri aktif)', sil.status === 200 && rdet.masalar.find((m) => m.id === silinen).aktif === false
        && rdet.masalar.find((m) => m.id === iki[1]).aktif === true, rdet.masalar);
    const pdfS = await ikili(`/api/root/plaka/talepler/${tp1.d.id}/baski.pdf`, rj);
    ok('O5: silinen masali talebin baski dosyasi uretilir (2 plaka + kapak)', pdfS.status === 200 && sayfaSay(pdfS.buf) === 3, pdfS.status);
    // O2 (root): kisa kodu yenile, ayrinti ve baski guncel kodu kullanir
    const eskiKod = rdet.masalar.find((m) => m.id === iki[1]).guncelKisaKod;
    const rk = await js(`/api/root/masalar/${iki[1]}/kisa-kod-yenile`, { token: rj, method: 'POST' });
    const rdet2 = (await js(`/api/root/plaka/talepler/${tp1.d.id}`, { token: rj })).d;
    ok('O2: root kisa kodu yeniler (8 hane, farkli), ayrinti guncel kodu gosterir', rk.status === 200 && rk.d.kisaKod.length === 8 && rk.d.kisaKod !== eskiKod
        && rdet2.masalar.find((m) => m.id === iki[1]).guncelKisaKod === rk.d.kisaKod, rk.d);
    ok('O2: eski kod artik cozulmez, yenisi cozulur', (await js('/api/public/q/' + eskiKod)).status === 404 && (await js('/api/public/q/' + rk.d.kisaKod)).status === 200);
    ok('O2: kiraci jetonu root kisa kod ucuna giremez (403)', (await js(`/api/root/masalar/${iki[1]}/kisa-kod-yenile`, { token: Y, method: 'POST' })).status === 403);
    ok('O2: silinmis masada root kisa kod yenileme 404', (await js(`/api/root/masalar/${silinen}/kisa-kod-yenile`, { token: rj, method: 'POST' })).status === 404);
    // D1: __proto__ / constructor parametreleri 500 vermez
    ok('D1: onizleme olcu=constructor 200 (varsayilan olcuyle)', (await js(`/api/plaka/onizleme?tableId=${iki[1]}&olcu=constructor`, { token: S })).status === 200);
    ok('D1: root durum islem=constructor 400', (await js(`/api/root/plaka/talepler/${tp1.d.id}/durum`, { token: rj, body: { islem: 'constructor' } })).status === 400);
    ok('D1: root durum islem=__proto__ 400', (await js(`/api/root/plaka/talepler/${tp1.d.id}/durum`, { token: rj, body: { islem: '__proto__' } })).status === 400);
    ok('D1: baski olcu=__proto__ 200', (await ikili(`/api/root/plaka/talepler/${tp1.d.id}/baski.pdf?olcu=__proto__`, rj)).status === 200);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
