const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const webpush = require('web-push');
const { query } = require('../config/db');
const A = require('./sistemAyar');

// ——— Telefon bildirimi (Web Push) ———
// Garson cagrisi ve QR siparisi, garson uygulamasi KAPALIYKEN de telefona dussun diye.
// Kasa paneli acikken SSE (eventBus) zaten aninda calar; bu ikinci, bagimsiz bir kanal.
//
// Kim alir: aboneligi olan VE rolu isletmenin bildirim_roller ayarinda bulunan aktif kullanici.
// Abonelik cihaz basinadir (ayni kisinin iki telefonu = iki satir).
//
// Best-effort: gonderim hatasi asil isi (cagri/siparis kaydi) ASLA bozmaz; istek yolunda
// beklenmez. Push servisi 404/410 donerse abonelik olmus demektir (uygulama silindi, izin
// geri alindi) ve satir silinir.

const OLAYLAR = ['garson', 'qr'];
const ROLLER = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'];
// Kasiyer varsayilanda yok: kasa paneli acik duruyor, orada zaten zil caliyor.
const VARSAYILAN_ROLLER = { garson: ['OWNER', 'MANAGER', 'WAITER'], qr: ['OWNER', 'MANAGER', 'WAITER'] };

// Ayar duzeltme: bilinmeyen olay/rol atilir, tekrarlar teklenir. Bozuk JSON = varsayilan.
function rolleriCoz(ham) {
    let v = ham;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    const out = {};
    for (const o of OLAYLAR) {
        const liste = v && Array.isArray(v[o]) ? v[o] : VARSAYILAN_ROLLER[o];
        out[o] = [...new Set(liste.filter((r) => ROLLER.includes(r)))];
    }
    return out;
}

// ——— VAPID anahtari ———
// Ortam degiskeni varsa o; yoksa sistem_ayarlari'ndan; o da yoksa ilk ihtiyacta uretilip saklanir.
// Anahtar DEGISIRSE butun abonelikler gecersiz kalir (telefonlar yeniden "ac" demeli) -
// bu yuzden bir kez uretilip kalici tutulur.
let _vapid = null;
async function vapid() {
    if (_vapid) return _vapid;
    let pub = process.env.VAPID_PUBLIC_KEY || '';
    let priv = process.env.VAPID_PRIVATE_KEY || '';
    if (!pub || !priv) {
        pub = await A.oku('vapid_public', '');
        priv = await A.oku('vapid_private', '');
        if (!pub || !priv) {
            const k = webpush.generateVAPIDKeys();
            // Ayni anda iki istek uretirse ikincisi birincinin yazdigini okusun
            await query("INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES ('vapid_public', ?)", [k.publicKey]);
            await query("INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES ('vapid_private', ?)", [k.privateKey]);
            pub = await A.oku('vapid_public', '');
            priv = await A.oku('vapid_private', '');
        }
    }
    const konu = process.env.VAPID_SUBJECT || 'mailto:info@mdayazilim.com';
    _vapid = { pub, priv, konu };
    return _vapid;
}
async function acikAnahtar() { return (await vapid()).pub; }

// Testte gercek push servisine gidilmez: PUSH_SAHTE_DOSYA tanimliysa (uretimde ASLA) her gonderim
// o dosyaya bir satir JSON olarak yazilir. Uc adresi "gone" iceren abonelik 410 almis gibi davranir.
function sahteDosya() {
    return process.env.NODE_ENV !== 'production' ? (process.env.PUSH_SAHTE_DOSYA || '') : '';
}

async function birineGonder(abonelik, yuk, secenek) {
    const sahte = sahteDosya();
    if (sahte) {
        if (/gone/.test(abonelik.endpoint)) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
        fs.appendFileSync(sahte, JSON.stringify({ endpoint: abonelik.endpoint, user_id: abonelik.user_id, yuk: JSON.parse(yuk), secenek }) + '\n');
        return;
    }
    const v = await vapid();
    await webpush.sendNotification(
        { endpoint: abonelik.endpoint, keys: { p256dh: abonelik.p256dh, auth: abonelik.auth } },
        yuk,
        { TTL: secenek.TTL, urgency: secenek.urgency, vapidDetails: { subject: v.konu, publicKey: v.pub, privateKey: v.priv } },
    );
}

async function abonelikleriGonder(abonelikler, veri, secenek = {}) {
    const yuk = JSON.stringify(veri);
    const ayar = { TTL: secenek.TTL || 300, urgency: secenek.urgency || 'high' };
    let gonderilen = 0;
    await Promise.all(abonelikler.map(async (s) => {
        try {
            await birineGonder(s, yuk, ayar);
            gonderilen++;
            await query('UPDATE push_abonelikleri SET son_basari_at = CURRENT_TIMESTAMP, hata_sayisi = 0 WHERE id = ?', [s.id]).catch(() => {});
        } catch (e) {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                await query('DELETE FROM push_abonelikleri WHERE id = ?', [s.id]).catch(() => {});
            } else {
                await query('UPDATE push_abonelikleri SET hata_sayisi = hata_sayisi + 1 WHERE id = ?', [s.id]).catch(() => {});
                console.error('[push]', e && (e.statusCode || e.message));
            }
        }
    }));
    return gonderilen;
}

// Isletme bildirim alabilir mi: aktif ve lisansi bitmemis (SSE akisiyla ayni kural)
async function isletmeAcik(tenantId) {
    const r = await query('SELECT is_active, license_end_date, bildirim_roller FROM tenants WHERE id = ?', [tenantId]);
    const t = r.rows[0];
    if (!t || !t.is_active) return null;
    if (t.license_end_date && Date.now() > new Date(t.license_end_date).getTime()) return null;
    return t;
}

// Olay bildirimi: olay 'garson' | 'qr'. veri: { baslik, govde, etiket, url }
async function olayBildir(tenantId, olay, veri) {
    try {
        if (!OLAYLAR.includes(olay)) return 0;
        const t = await isletmeAcik(tenantId);
        if (!t) return 0;
        const roller = rolleriCoz(t.bildirim_roller)[olay];
        if (!roller.length) return 0;
        const r = await query(
            `SELECT s.* FROM push_abonelikleri s JOIN users u ON u.id = s.user_id
              WHERE s.tenant_id = ? AND u.tenant_id = s.tenant_id AND u.is_active = 1
                AND u.role IN (${roller.map(() => '?').join(',')})`,
            [tenantId, ...roller]);
        if (!r.rows.length) return 0;
        return await abonelikleriGonder(r.rows, { olay, ...veri });
    } catch (e) {
        console.error('[push] olay', e.message);
        return 0;
    }
}

// Istek yolunu bekletmeden gonder (cagri/siparis cevabi push servisini beklemesin)
function arkadaBildir(tenantId, olay, veri) {
    setImmediate(() => { olayBildir(tenantId, olay, veri).catch(() => {}); });
}

// ——— Abonelik kaydi ———
const B64URL = /^[A-Za-z0-9_-]+=*$/;
function abonelikDogrula(s) {
    if (!s || typeof s !== 'object') return 'Abonelik bilgisi eksik.';
    const ep = typeof s.endpoint === 'string' ? s.endpoint : '';
    let u = null;
    try { u = new URL(ep); } catch (_) { u = null; }
    if (!u || u.protocol !== 'https:' || ep.length > 1000) return 'Geçersiz bildirim adresi.';
    const k = s.keys || {};
    if (typeof k.p256dh !== 'string' || !B64URL.test(k.p256dh) || k.p256dh.length < 40 || k.p256dh.length > 200) return 'Geçersiz abonelik anahtarı.';
    if (typeof k.auth !== 'string' || !B64URL.test(k.auth) || k.auth.length < 8 || k.auth.length > 100) return 'Geçersiz abonelik anahtarı.';
    return '';
}

// Ayni cihaz (endpoint) baska kullaniciyla giris yaptiysa abonelik yeni kullaniciya gecer:
// telefonu devralan garson, eski garsonun bildirimlerini almasin.
async function aboneKaydet(user, s, cihaz) {
    const var_ = await query('SELECT id FROM push_abonelikleri WHERE endpoint = ?', [s.endpoint]);
    const ua = String(cihaz || '').slice(0, 160);
    if (var_.rows.length) {
        await query(
            `UPDATE push_abonelikleri SET tenant_id = ?, user_id = ?, p256dh = ?, auth = ?, cihaz = ?,
                    son_gorulme_at = CURRENT_TIMESTAMP, hata_sayisi = 0 WHERE id = ?`,
            [user.tenantId, user.id, s.keys.p256dh, s.keys.auth, ua, var_.rows[0].id]);
        return var_.rows[0].id;
    }
    const id = uuidv4();
    await query(
        `INSERT INTO push_abonelikleri (id, tenant_id, user_id, endpoint, p256dh, auth, cihaz)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, user.tenantId, user.id, s.endpoint, s.keys.p256dh, s.keys.auth, ua]);
    return id;
}

// Kullanici hangi olaylar icin bildirim alir (garson uygulamasindaki aciklama icin)
async function alacagiOlaylar(user) {
    const r = await query('SELECT bildirim_roller FROM tenants WHERE id = ?', [user.tenantId]);
    const roller = rolleriCoz(r.rows[0] && r.rows[0].bildirim_roller);
    return OLAYLAR.filter((o) => roller[o].includes(user.role));
}

module.exports = {
    OLAYLAR, ROLLER, VARSAYILAN_ROLLER, rolleriCoz,
    acikAnahtar, olayBildir, arkadaBildir, abonelikleriGonder,
    abonelikDogrula, aboneKaydet, alacagiOlaylar,
};
