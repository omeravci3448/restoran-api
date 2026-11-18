const { query } = require('../config/db');

// --- Lansman kampanyasi "%50 lansman indirimi" (Patron karari 2026-11-18) ---
// Kural:
//   - Kampanya bitis gunune (lansman_kayit_son, Istanbul gun sonu; varsayilan 30.11.2026) kadar kayit olup denemesini
//     baslatan (tenants.created_at; deneme kayitla ayni anda baslar) isletme,
//   - ILK satin almasinda (lisansTalep tur 'ilk': deneme sinifi, onayli odeme yok) kampanya indirimini alir
//     (lansman_yuzde, varsayilan %50),
//   - yalniz odeme deneme bitis gununden en gec N gun sonra (lansman_odeme_gun, varsayilan 1; Istanbul gun sonu)
//     yapilirsa: "Odemeyi yaptim" bu gunden sonra 409 KAMPANYA_SURESI_DOLDU (licenseController.markPaid).
//   - Haric: SofraMix kanali (parent_org 'SofraMix', TIER_SOFRAMIX, SofraMix deneme devriyle acilan isletme).
//   - Birlesmez: indirim = en buyuk(kampanya, kiraci indirimi discount_rate). Kiraci indirimi buyuk ya da esitse
//     kampanya uygulanmaz (normal indirim gorunur).
// Talep aninda kayda kampanya_orani ve kampanya_son_gun (YYYY-MM-DD, Istanbul) yazilir; onayda yeniden hesaplanmaz.
// Ayarlar root Sistem Ayarlari > Lansman kampanyasi (services/yonetimAyar.js): lansman_acik, lansman_yuzde,
// lansman_kayit_son, lansman_odeme_gun.

const VARSAYILAN_KAYIT_SON = '2026-11-30';
const KOD = 'LANSMAN';
const GUN_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function gecerliGun(s) {
    const m = GUN_RE.exec(String(s || '').trim());
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
// Istanbul gun sonu (Turkiye yaz saati uygulamiyor: +03:00 sabit)
const gunSonu = (gun) => new Date(`${gun}T23:59:59.999+03:00`);
const istanbulGunu = (d) => require('./yonetimOzet').istanbulParcalari(d).bugun;
function gunEkle(gun, n) {
    const m = GUN_RE.exec(gun);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + Number(n || 0)));
    return d.toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' -> 'GG.AA.YYYY'
const gunTR = (gun) => (gecerliGun(gun) ? gun.split('-').reverse().join('.') : '-');

// SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) ya da ISO -> Date
function tarihOku(s) {
    if (!s) return null;
    const m = String(s);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m) ? m.replace(' ', 'T') + 'Z' : m);
    return Number.isNaN(d.getTime()) ? null : d;
}

async function ayarlar() {
    const YA = require('./yonetimAyar');
    const r = await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'lansman_kayit_son'");
    const ham = r.rows[0] && r.rows[0].deger != null ? String(r.rows[0].deger).trim() : '';
    const kayitSon = gecerliGun(ham) ? ham : VARSAYILAN_KAYIT_SON;
    const acik = (await YA.sayiOku('lansman_acik')) !== 0;
    return { acik, yuzde: await YA.sayiOku('lansman_yuzde'), kayitSon, odemeGun: await YA.sayiOku('lansman_odeme_gun') };
}

// Tanitim sayfasi icin: kampanya su an yeni kayitlara acik mi (ayar acik ve bitis gunu gecmedi)
async function herkeseAcik(simdi = new Date()) {
    const a = await ayarlar();
    const acik = a.acik && simdi.getTime() <= gunSonu(a.kayitSon).getTime();
    return { acik, yuzde: a.yuzde, kayitSon: a.kayitSon, odemeGun: a.odemeGun };
}

// SofraMix kanali: parent_org, paket kodu ya da SofraMix deneme devri / SofraMix numarali deneme kaydi
async function soframixKanali(t) {
    if (t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX') return true;
    const r = await query(
        `SELECT 1 FROM deneme_kayitlari WHERE tenant_id = ?
            AND (soframix_business_id IS NOT NULL AND soframix_business_id <> '' OR kaynak LIKE 'soframix%') LIMIT 1`, [t.id]);
    return r.rows.length > 0;
}

// Isletme bu an kampanyadan yararlanabilir mi? Cagiran ilk alim (deneme sinifi) oldugunu bilir; burada yine de onayli
// odeme kontrol edilir. Doner { uygun, yuzde, sonGun (YYYY-MM-DD), sebep }
async function uygunluk(tenantId, simdi = new Date()) {
    const a = await ayarlar();
    const t = (await query('SELECT id, parent_org, license_tier, license_end_date, created_at FROM tenants WHERE id = ?', [tenantId])).rows[0];
    const hayir = (sebep, ek = {}) => ({ uygun: false, yuzde: a.yuzde, sonGun: null, sebep, ...ek });
    if (!t) return hayir('isletme_yok');
    if (!a.acik || !(a.yuzde > 0)) return hayir('kapali');
    const kayit = tarihOku(t.created_at);
    if (!kayit || kayit.getTime() > gunSonu(a.kayitSon).getTime()) return hayir('kayit_tarihi');
    if (await soframixKanali(t)) return hayir('soframix');
    if (await require('./lisansTalep').odemeGecmisiVar(t.id)) return hayir('ilk_alim_degil');
    const bitis = tarihOku(t.license_end_date);
    if (!bitis) return hayir('deneme_bitisi_yok');
    const sonGun = gunEkle(istanbulGunu(bitis), a.odemeGun);
    if (simdi.getTime() > gunSonu(sonGun).getTime()) return hayir('suresi_doldu', { sonGun });
    return { uygun: true, yuzde: a.yuzde, sonGun, sebep: null };
}

// Kampanyali kaydin son gunu gecti mi (markPaid). o: lisans_odemeleri satiri
function kayitSuresiDoldu(o, simdi = new Date()) {
    if (!o || !(Number(o.kampanya_orani) > 0) || !gecerliGun(o.kampanya_son_gun)) return false;
    return simdi.getTime() > gunSonu(o.kampanya_son_gun).getTime();
}

const SURESI_DOLDU_MESAJI = 'Lansman indirimi süresi doldu. Lütfen seçiminizi yenileyin; yeni tutar indirimsiz hesaplanır.';

module.exports = {
    KOD, VARSAYILAN_KAYIT_SON, SURESI_DOLDU_MESAJI, gecerliGun, gunSonu, gunEkle, gunTR, ayarlar, herkeseAcik, soframixKanali,
    uygunluk, kayitSuresiDoldu,
};
