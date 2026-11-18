// --- Odeme korumasi (Patron karari 2026-11-18) ---
// Musteri havaleyi yapip "Odemeyi yaptim" dediyse, onay beklerken lisansi bitse de program ACIK kalir:
// odeme_bildirildi_at + N gun boyunca isletme AKTIF sayilir (satis, kayit, her sey). N = root ayari
// odeme_koruma_gun (varsayilan 3; 0 = koruma kapali).
// Kosullar:
//   - kiracinin durum = 'beklemede' ve odeme_bildirildi_at dolu bir kaydi var (ayni anda tek bekleyen kurali)
//   - simdi < odeme_bildirildi_at + N gun
//   - bu bildirimden onceki 30 gun icinde REDDEDILMIS bir kaydi yok (red edilen musteri ikinci bildirimle
//     yeniden 3 gun kazanamasin)
// Musteri bildirimi iptal ederse ya da root reddederse koruma HEMEN biter (kayit artik 'beklemede' degil).
// Onayda lisans zaten uzar.
//
// lisansDurumu.hesapla SAF kalir; bu sarmalayici yalniz istegin lisans durumunu belirleyen yerlerde kullanilir
// (authMiddleware.protect -> /api/auth/me dahil, giris, QR menu). Root ekranlari GERCEK durumu gosterir.
//
// Onbellek: korunan kiracilar tek sorguyla okunur ve ~30 sn saklanir; bildirim/iptal/red/onayda hemen tazelenir.

const { query } = require('../config/db');
const L = require('./lisansDurumu');

const GUN_MS = 86400000;
const OMUR_MS = Number(process.env.ODEME_KORUMA_ONBELLEK_MS) >= 0 && process.env.ODEME_KORUMA_ONBELLEK_MS !== undefined
    && process.env.ODEME_KORUMA_ONBELLEK_MS !== '' ? Number(process.env.ODEME_KORUMA_ONBELLEK_MS) : 30000;   // test: kisa omur
let harita = new Map();      // tenantId -> bitis (Date)
let sonYukleme = 0;
let yukleniyor = null;

function korumaGun() {
    try { return require('./yonetimAyar').odemeKorumaGun(); } catch (_) { return 3; }
}

// SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) ya da ISO -> Date
function tarihOku(s) {
    if (!s) return null;
    const m = String(s);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m) ? m.replace(' ', 'T') + 'Z' : m);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Bir bildirimin koruma bitisi (kosullar saglanmiyorsa null). o: { odeme_bildirildi_at }, redVar: son 30 gunde red
function bitisHesapla(bildirildi, gun = korumaGun()) {
    const b = tarihOku(bildirildi);
    if (!b || !(gun > 0)) return null;
    return new Date(b.getTime() + gun * GUN_MS);
}

async function yukle() {
    if (yukleniyor) return yukleniyor;
    yukleniyor = (async () => {
        const yeni = new Map();
        const gun = korumaGun();
        if (gun > 0) {
            const r = await query(
                `SELECT o.tenant_id, MAX(o.odeme_bildirildi_at) AS bildirildi
                   FROM lisans_odemeleri o
                  WHERE o.durum = 'beklemede' AND o.odeme_bildirildi_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM lisans_odemeleri r
                                     WHERE r.tenant_id = o.tenant_id AND r.durum = 'reddedildi'
                                       AND r.islenen_at >= datetime(o.odeme_bildirildi_at, '-30 days'))
                  GROUP BY o.tenant_id`);
            const simdi = Date.now();
            for (const x of r.rows) {
                const bitis = bitisHesapla(x.bildirildi, gun);
                if (bitis && bitis.getTime() > simdi) yeni.set(x.tenant_id, bitis);
            }
        }
        harita = yeni;
        sonYukleme = Date.now();
    })().catch((e) => { console.error('[odeme-korumasi] yukleme:', e.message); sonYukleme = Date.now(); })
        .finally(() => { yukleniyor = null; });
    return yukleniyor;
}

// Bildirim / iptal / red / onay sonrasi: bir sonraki istek taze durumu gorsun
async function tazele() { sonYukleme = 0; await yukle(); }

async function hazirla() {
    if (Date.now() - sonYukleme > OMUR_MS) await yukle();
}

// Senkron (QR menu gibi senkron yerler): bellekteki deger; gerekirse arka planda tazeler
function bitisSenkron(tenantId) {
    if (Date.now() - sonYukleme > OMUR_MS && !yukleniyor) yukle();
    const b = harita.get(tenantId);
    return b && b.getTime() > Date.now() ? b : null;
}

async function bitis(tenantId) {
    await hazirla();
    return bitisSenkron(tenantId);
}

function sarmala(ld, b) {
    if (!b) return ld;
    return { ...ld, durum: L.DURUM.AKTIF, gercekDurum: ld.durum, odemeKorumasi: { bitis: b.toISOString() } };
}

// Istegin lisans durumu: hesapla() + odeme korumasi. AKTIF lisansta sorgu yapilmaz.
async function etkinDurum(tenantId, licenseEndDate, simdi = new Date()) {
    const ld = L.hesapla(licenseEndDate, simdi);
    if (ld.durum === L.DURUM.AKTIF || !tenantId) return ld;
    return sarmala(ld, await bitis(tenantId));
}

function etkinDurumSenkron(tenantId, licenseEndDate, simdi = new Date()) {
    const ld = L.hesapla(licenseEndDate, simdi);
    if (ld.durum === L.DURUM.AKTIF || !tenantId) return ld;
    return sarmala(ld, bitisSenkron(tenantId));
}

// Musteri lisans sayfasi icin: bu bekleyen kaydin koruma bitisi (lisans durumundan bagimsiz). Kosul sorgusu taze.
async function kayitKorumaBitisi(o) {
    if (!o || o.durum !== 'beklemede' || !o.odeme_bildirildi_at) return null;
    const b = bitisHesapla(o.odeme_bildirildi_at);
    if (!b || b.getTime() <= Date.now()) return null;
    const r = await query(
        `SELECT 1 FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'reddedildi'
            AND islenen_at >= datetime(?, '-30 days') LIMIT 1`, [o.tenant_id, o.odeme_bildirildi_at]);
    return r.rows.length ? null : b;
}

module.exports = { etkinDurum, etkinDurumSenkron, tazele, yukle, kayitKorumaBitisi, bitisHesapla, korumaGun };
