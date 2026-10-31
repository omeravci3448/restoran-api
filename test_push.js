// Telefon bildirimi (Web Push): abonelik, rol ayari, kime gittigi, tekrar cagri freni, 410 temizligi,
// pasif kullanici, kiraci yalitimi, cihaz devri, lisans bitince sessizlik, deneme bildirimi.
// Gercek push servisine gidilmez: PUSH_SAHTE_DOSYA'ya yazilan satirlar okunur (services/pushBildirim.js).
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45973, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
const SAHTE = path.join(os.tmpdir(), `mda-push-test-${process.pid}.jsonl`);
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const ISIMLER = ['Push Test Lokanta', 'Push Komsu Lokanta'];

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779211, isletme_slug: 'push-test', isletme_adi: ISIMLER[0],
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Push Sahibi', yetkili_email: 'push-sahibi@ornek.test', yetkili_tel: '05321113377',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'), ...x,
    };
}
const kanonik = (g) => JSON.stringify(g, Object.keys(g).sort());
function baglanti(g) {
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', '1');
    u.searchParams.set('yuk', Buffer.from(kanonik(g), 'utf8').toString('base64url'));
    u.searchParams.set('imza', crypto.createHmac('sha256', GIZLI).update(kanonik(g)).digest('hex'));
    return u.toString();
}
async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name IN (${ISIMLER.map(() => '?').join(',')})`, ISIMLER);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['push_abonelikleri', 'payments', 'stock_movements', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories',
                          'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels', 'license_cache', 'islem_gunlugu',
                          'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id IN ('779211', '779212')");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no IN ('779211', '779212')");
    try { fs.unlinkSync(SAHTE); } catch (_) {}
}
// Sahte gonderim dosyasindan satirlar; once: bu kadar satiri atla (onceki adimlar)
function giden(once = 0) {
    let s = '';
    try { s = fs.readFileSync(SAHTE, 'utf8'); } catch (_) { return []; }
    return s.split('\n').filter(Boolean).map((x) => JSON.parse(x)).slice(once);
}
const ep = (ad) => `https://push.ornek.test/abone/${ad}`;
const abonelik = (ad) => ({ endpoint: ep(ad), keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) } });
const alicilar = (satirlar) => satirlar.map((x) => x.endpoint.split('/').pop()).sort();

async function isletmeKur(g, personel) {
    const r = await fetch(baglanti(g), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tokenlar = { sahip: sahip.token };
    for (const [ad, rol] of personel) {
        const email = `push-${g.isletme_no}-${ad}@ornek.test`;
        await js('/api/auth/staff', { token: sahip.token, body: { email, password: 'personel123', name: ad, role: rol } });
        tokenlar[ad] = (await js('/api/auth/login', { body: { email, businessCode: me.businessCode, password: 'personel123' } })).d.token;
    }
    await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [me.tenantId]);
    return { tid: me.tenantId, tokenlar };
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'push-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development',
               PUSH_SAHTE_DOSYA: SAHTE } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik ===');
    const A = await isletmeKur(govde(), [['mudur', 'MANAGER'], ['garson', 'WAITER'], ['kasiyer', 'CASHIER']]);
    const T = A.tokenlar;
    const m1 = (await js('/api/tables', { token: T.sahip, body: { code: 'M1', name: 'Masa 1', section: 'Bahçe' } })).d;
    const kat = (await js('/api/categories', { token: T.sahip, body: { name: 'Tatlilar' } })).d;
    const u1 = (await js('/api/products', { token: T.sahip, body: { name: 'Sutlac', price: 120, categoryId: kat.id, isAvailable: true } })).d;
    const slug = (await js('/api/tenant/me', { token: T.sahip })).d.slug;
    const qr = (await query('SELECT qr_token FROM tables WHERE id = ?', [m1.id])).rows[0].qr_token;
    const cagir = () => js(`/api/public/m/${slug}/${qr}/waiter`, { body: { reason: 'GENERIC' } });
    const siparis = () => js(`/api/public/m/${slug}/${qr}/orders`, { body: { items: [{ productId: u1.id, qty: 2 }], note: '<b>sahte buton</b>' } });
    const cagrilariKapat = () => query("UPDATE waiter_calls SET status = 'HANDLED' WHERE tenant_id = ?", [A.tid]);
    ok('isletme + 4 rol + masa + urun hazir', !!(T.mudur && T.garson && T.kasiyer && m1.id && u1.id));

    console.log('\n=== 1) Durum ve abonelik dogrulamasi ===');
    ok('oturumsuz durum 401', (await js('/api/push/durum')).status === 401);
    const d1 = await js('/api/push/durum', { token: T.mudur });
    ok('mudur: acik anahtar (87 kr base64url) + garson ve qr', d1.status === 200 && /^[A-Za-z0-9_-]{87}$/.test(d1.d.publicKey)
        && JSON.stringify(d1.d.olaylar) === '["garson","qr"]' && d1.d.rol === 'MANAGER', d1);
    const d2 = await js('/api/push/durum', { token: T.garson });
    ok('anahtar kalici (ikinci istekte ayni)', d2.d.publicKey === d1.d.publicKey);
    ok('kasiyer varsayilanda bildirim almaz', JSON.stringify((await js('/api/push/durum', { token: T.kasiyer })).d.olaylar) === '[]');
    ok('http adres reddedilir (400)', (await js('/api/push/abone', { token: T.mudur, body: { subscription: { ...abonelik('x'), endpoint: 'http://push.ornek.test/x' } } })).status === 400);
    ok('anahtarsiz abonelik reddedilir (400)', (await js('/api/push/abone', { token: T.mudur, body: { subscription: { endpoint: ep('y') } } })).status === 400);
    ok('oturumsuz abonelik 401', (await js('/api/push/abone', { body: { subscription: abonelik('z') } })).status === 401);
    for (const ad of ['sahip', 'mudur', 'garson', 'kasiyer']) {
        const r = await js('/api/push/abone', { token: T[ad], body: { subscription: abonelik(ad) } });
        ok(`${ad} abone oldu`, r.status === 200 && r.d.ok, r);
    }
    await js('/api/push/abone', { token: T.garson, body: { subscription: abonelik('gone-eski-telefon') } });

    console.log('\n=== 2) Garson cagrisi ===');
    let once = giden().length;
    const c1 = await cagir();
    ok('cagri 201', c1.status === 201, c1);
    await uyu(500);
    let g = giden(once);
    ok('varsayilan: sahip + mudur + garson alir, kasiyer almaz', JSON.stringify(alicilar(g)) === '["garson","mudur","sahip"]', alicilar(g));
    ok('baslik masa adiyla, govde bolum + sabit metin, cagrilar sekmesine gider',
        g[0] && g[0].yuk.olay === 'garson' && g[0].yuk.baslik === '🔔 Masa 1 garson çağırıyor'
        && g[0].yuk.govde === 'Bahçe · Masaya bekleniyor' && g[0].yuk.url === '/garson/?sekme=cagrilar', g[0]);
    ok('acil + 5 dk omur', g[0] && g[0].secenek.urgency === 'high' && g[0].secenek.TTL === 300, g[0] && g[0].secenek);
    const olu = await query('SELECT 1 FROM push_abonelikleri WHERE endpoint = ?', [ep('gone-eski-telefon')]);
    ok('410 donen (silinmis uygulama) abonelik temizlendi', olu.rows.length === 0);

    once = giden().length;
    const c2 = await cagir();
    await uyu(400);
    ok('60 sn icinde ikinci cagri: ayni kayit, yeni bildirim yok', c2.status === 200 && c2.d.tekrar === true && c2.d.id === c1.d.id && giden(once).length === 0, [c2, giden(once).length]);
    ok('tek bekleyen cagri kaydi', Number((await query("SELECT COUNT(*) AS c FROM waiter_calls WHERE tenant_id = ? AND status = 'PENDING'", [A.tid])).rows[0].c) === 1);

    console.log('\n=== 3) QR siparisi ===');
    once = giden().length;
    const s1 = await siparis();
    await uyu(500);
    g = giden(once);
    ok('QR siparisi 201 ve ayni uc kisiye bildirim', s1.status === 201 && JSON.stringify(alicilar(g)) === '["garson","mudur","sahip"]', [s1.status, alicilar(g)]);
    ok('QR bildirimi: kalem + tutar, musteri notu YOK, masa ekranina gider',
        g[0] && g[0].yuk.olay === 'qr' && g[0].yuk.baslik === '🧾 Masa 1: yeni QR siparişi' && /^1 kalem · 240 ₺$/.test(g[0].yuk.govde)
        && !/sahte/.test(JSON.stringify(g[0].yuk)) && g[0].yuk.url === '/garson/masa/' + m1.id, g[0] && g[0].yuk);
    await js('/api/tenant/me', { token: T.sahip, method: 'PUT', body: { qrOnayGerekli: true } });
    once = giden().length;
    await siparis();
    await uyu(500);
    g = giden(once);
    ok('kasa onayi acikken bildirimde "Kasa onayı bekliyor"', g[0] && /Kasa onayı bekliyor$/.test(g[0].yuk.govde), g[0] && g[0].yuk);
    await js('/api/tenant/me', { token: T.sahip, method: 'PUT', body: { qrOnayGerekli: false } });

    console.log('\n=== 4) Rol ayari ===');
    const kotu = await js('/api/tenant/me', { token: T.sahip, method: 'PUT', body: { bildirimRoller: ['MANAGER'] } });
    ok('dizi ayar reddedilir (400)', kotu.status === 400, kotu);
    const garsonAyar = await js('/api/tenant/me', { token: T.garson, method: 'PUT', body: { bildirimRoller: { garson: ['WAITER'] } } });
    ok('garson rol ayarini degistiremez (403)', garsonAyar.status === 403, garsonAyar);
    const ayar = await js('/api/tenant/me', { token: T.mudur, method: 'PUT', body: { bildirimRoller: { garson: ['MANAGER', 'KASA_HACK', 'MANAGER'], qr: [] } } });
    ok('mudur ayarladi (200)', ayar.status === 200, ayar);
    const prof = (await js('/api/tenant/me', { token: T.mudur })).d;
    ok('kayit temizlendi: garson=[MANAGER], qr=[]', JSON.stringify(prof.bildirim_roller) === '{"garson":["MANAGER"],"qr":[]}', prof.bildirim_roller);
    ok('garson artik hicbir olay almaz (durum)', JSON.stringify((await js('/api/push/durum', { token: T.garson })).d.olaylar) === '[]');
    await cagrilariKapat();
    once = giden().length;
    await cagir(); await siparis();
    await uyu(500);
    g = giden(once);
    ok('cagri yalniz mudure, QR kimseye', JSON.stringify(g.map((x) => [x.yuk.olay, x.endpoint.split('/').pop()])) === '[["garson","mudur"]]', g.map((x) => x.yuk.olay));
    // Baska alan dokunulmadan ayar korunur (ornegin yalniz qrOnayGerekli kaydedilince)
    await js('/api/tenant/me', { token: T.mudur, method: 'PUT', body: { mutfakEkrani: false } });
    ok('baska ayar kaydi bildirim rollerini bozmaz', JSON.stringify((await js('/api/tenant/me', { token: T.mudur })).d.bildirim_roller.garson) === '["MANAGER"]');
    await js('/api/tenant/me', { token: T.mudur, method: 'PUT', body: { bildirimRoller: { qr: ['CASHIER'] } } });
    ok('yalniz qr gonderilince garson ayari korunur (varsayilana donmez)',
        JSON.stringify((await js('/api/tenant/me', { token: T.mudur })).d.bildirim_roller) === '{"garson":["MANAGER"],"qr":["CASHIER"]}');

    console.log('\n=== 5) Pasif kullanici, cihaz devri, iptal ===');
    await query("UPDATE users SET is_active = 0 WHERE tenant_id = ? AND role = 'MANAGER'", [A.tid]);
    await cagrilariKapat();
    once = giden().length;
    await cagir(); await uyu(500);
    ok('pasif mudure bildirim gitmez', giden(once).length === 0, giden(once));
    await query("UPDATE users SET is_active = 1 WHERE tenant_id = ? AND role = 'MANAGER'", [A.tid]);
    await js('/api/tenant/me', { token: T.sahip, method: 'PUT', body: { bildirimRoller: { garson: ['OWNER', 'MANAGER', 'WAITER'], qr: ['OWNER', 'MANAGER', 'WAITER'] } } });
    // Mudurun telefonu garsona gecti: ayni endpoint ile garson abone olur
    const devir = await js('/api/push/abone', { token: T.garson, body: { subscription: abonelik('mudur') } });
    const sahibi = (await query('SELECT u.role FROM push_abonelikleri s JOIN users u ON u.id = s.user_id WHERE s.endpoint = ?', [ep('mudur')])).rows[0];
    ok('ayni cihaz yeni kullaniciya gecer (tek satir)', devir.status === 200 && sahibi && sahibi.role === 'WAITER'
        && Number((await query('SELECT COUNT(*) AS c FROM push_abonelikleri WHERE endpoint = ?', [ep('mudur')])).rows[0].c) === 1, sahibi);
    const baskasi = await js('/api/push/iptal', { token: T.kasiyer, body: { endpoint: ep('sahip') } });
    ok('baskasinin cihazi iptal edilemez (satir duruyor)', baskasi.status === 200
        && (await query('SELECT 1 FROM push_abonelikleri WHERE endpoint = ?', [ep('sahip')])).rows.length === 1);
    const kendi = await js('/api/push/iptal', { token: T.kasiyer, body: { endpoint: ep('kasiyer') } });
    ok('kendi cihazini iptal eder', kendi.status === 200 && (await query('SELECT 1 FROM push_abonelikleri WHERE endpoint = ?', [ep('kasiyer')])).rows.length === 0);

    console.log('\n=== 6) Kiraci yalitimi ===');
    const B = await isletmeKur(govde({ isletme_no: 779212, isletme_slug: 'push-komsu', isletme_adi: ISIMLER[1],
        yetkili_email: 'push-komsu@ornek.test', yetkili_tel: '05321113388' }), [['garson', 'WAITER']]);
    await js('/api/push/abone', { token: B.tokenlar.garson, body: { subscription: abonelik('komsu-garson') } });
    await cagrilariKapat();
    once = giden().length;
    await cagir(); await uyu(500);
    g = giden(once);
    ok('A masasindaki cagri B isletmesinin telefonuna gitmez', g.length > 0 && !g.some((x) => /komsu/.test(x.endpoint)), alicilar(g));

    console.log('\n=== 7) Deneme bildirimi ===');
    once = giden().length;
    const den = await js('/api/push/deneme', { token: T.sahip, method: 'POST' });
    g = giden(once);
    ok('deneme yalniz kendi cihazina', den.status === 200 && den.d.ok && JSON.stringify(alicilar(g)) === '["sahip"]' && g[0].yuk.olay === 'deneme', [den, alicilar(g)]);
    ok('10 sn icinde tekrar deneme 429', (await js('/api/push/deneme', { token: T.sahip, method: 'POST' })).status === 429);
    ok('cihazi olmayan hesapta deneme 404', (await js('/api/push/deneme', { token: T.kasiyer, method: 'POST' })).status === 404);

    console.log('\n=== 8) Lisans bitince ===');
    await query("UPDATE tenants SET license_end_date = datetime('now', '-1 day') WHERE id = ?", [A.tid]);
    await cagrilariKapat();
    once = giden().length;
    const sonCagri = await cagir(); await uyu(500);
    ok('lisansi bitmis isletmede cagri kaydi olur ama telefona bildirim gitmez', sonCagri.status === 201 && giden(once).length === 0, giden(once));

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
