const { query } = require('../config/db');

// --- Lisans yenileme hatirlatmasi (e-posta) ---
// Saatte bir tarar; yalniz SMTP tanimliysa calisir (server.js baslat()). Gonderim yalniz Istanbul saatiyle
// 10:00 - 20:00 arasinda. Her (isletme, tur, bitis tarihi) icin EN FAZLA bir kez (lisans_hatirlatmalari UNIQUE).
//
// Ne zaman (Istanbul takvim gunu; bitis gunu ile bugun arasindaki fark):
//   Ucretli lisans : 30, 7, 1 gun once ve bitisin ertesi gunu (1 gun sonra)
//   Deneme         : 2 gun once ve son gun (bitis gunu)
// Atlanir: pasif isletme, bitis tarihi olmayan (sinirsiz) lisans, onay bekleyen odeme bildirimi olan isletme
// (lisans_odemeleri durum 'beklemede' + odeme_bildirildi_at), root ayari lisans_hatirlatma_acik = 0.
// Alicilar: isletmenin aktif SAHIP (OWNER) hesaplarinin e-postalari (tekillestirilmis).
// SofraMix kanali (parent_org 'SofraMix' ya da TIER_SOFRAMIX): yenileme SofraMix'ten yapilir, baglanti oraya.
//
// "Hangi hatirlatma zamani geldi" hesabi saf islevlerdir (hatirlatmaTuru, gunFarki, gonderimSaatiMi):
// test_kayit_hatirlatma.js SMTP olmadan dener.

const ARALIK_MS = 60 * 60 * 1000;
const ILK_GECIKME_MS = 3 * 60 * 1000;
const GUN_MS = 86400000;
// Turkiye 2016'dan beri yaz-kis saati uygulamiyor: sabit UTC+3. Intl'e bagli kalmamak icin elle.
const ISTANBUL_FARK_MS = 3 * 60 * 60 * 1000;
const BASLA_SAAT = 10, BITIS_SAAT = 20;

const UCRETLI_GUNLER = { 30: 'once_30', 7: 'once_7', 1: 'once_1', '-1': 'sonra_1' };
const DENEME_GUNLER = { 2: 'deneme_2', 0: 'deneme_son' };

function tarihGecerli(t) {
    const d = t instanceof Date ? t : new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Verilen anin Istanbul takvim gunu: 'YYYY-MM-DD'
function istanbulGun(t) {
    const d = tarihGecerli(t);
    if (!d) return null;
    return new Date(d.getTime() + ISTANBUL_FARK_MS).toISOString().slice(0, 10);
}

// Istanbul saatiyle saat (0-23)
function istanbulSaat(t) {
    const d = tarihGecerli(t);
    return d ? new Date(d.getTime() + ISTANBUL_FARK_MS).getUTCHours() : null;
}

// Bitis gunune kac takvim gunu var (Istanbul). Bugun bitiyorsa 0, dun bittiyse -1.
function gunFarki(bitis, simdi = new Date()) {
    const b = istanbulGun(bitis), s = istanbulGun(simdi);
    if (!b || !s) return null;
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(s + 'T00:00:00Z')) / GUN_MS);
}

function gonderimSaatiMi(simdi = new Date()) {
    const h = istanbulSaat(simdi);
    return h != null && h >= BASLA_SAAT && h < BITIS_SAAT;
}

const denemeMi = (tier) => tier === 'TIER_DENEME';
const sofraMixMi = (t) => !!t && (t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX');

// Saf: bu isletme icin BUGUN hangi hatirlatma turu zamani geldi? Yoksa null.
// t: { license_tier, license_end_date }
function hatirlatmaTuru(t, simdi = new Date()) {
    if (!t || !t.license_end_date) return null;
    const fark = gunFarki(t.license_end_date, simdi);
    if (fark == null) return null;
    const tablo = denemeMi(t.license_tier) ? DENEME_GUNLER : UCRETLI_GUNLER;
    return tablo[String(fark)] || null;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function tarihMetni(t) {
    const g = istanbulGun(t);
    if (!g) return '';
    const [y, a, d] = g.split('-');
    return `${d}.${a}.${y}`;
}

function adresler() {
    const panel = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
    const smx = (process.env.SOFRAMIX_PANEL_URL || 'https://isletme.soframix.com.tr').replace(/\/+$/, '');
    return { lisans: panel + '/lisans', soframix: smx + '/isletme/pos' };
}

// Saf: e-posta konusu ve govdesi. o: { tur, isletmeAdi, bitis, sofraMix, toleransGun }
function icerik(o) {
    const A = adresler();
    const tarih = tarihMetni(o.bitis);
    const smx = !!o.sofraMix;
    const baglanti = smx ? A.soframix : A.lisans;
    const dugme = smx ? 'SofraMix işletme paneline git' : 'Lisans sayfasını aç';
    const yenilemeYeri = smx
        ? 'Yenileme işlemi SofraMix işletme paneliniz üzerinden yapılır.'
        : 'Lisansınızı panelinizdeki Lisans sayfasından yenileyebilirsiniz.';
    let konu, metin;
    switch (o.tur) {
    case 'once_30':
        konu = 'Lisansınızın bitmesine 30 gün kaldı';
        metin = `MDA Restoran POS lisansınız <b>${tarih}</b> tarihinde sona erecektir. ${yenilemeYeri}`;
        break;
    case 'once_7':
        konu = 'Lisansınızın bitmesine 7 gün kaldı';
        metin = `MDA Restoran POS lisansınız <b>${tarih}</b> tarihinde sona erecektir. Hizmetin kesintisiz sürmesi için yenilemeyi şimdiden yapmanızı öneririz. ${yenilemeYeri}`;
        break;
    case 'once_1':
        konu = 'Lisansınız yarın sona eriyor';
        metin = `MDA Restoran POS lisansınız yarın (<b>${tarih}</b>) sona erecektir. ${yenilemeYeri}`;
        break;
    case 'sonra_1': {
        const n = Number(o.toleransGun) || 0;
        konu = 'Lisansınızın süresi doldu';
        metin = `MDA Restoran POS lisansınızın süresi <b>${tarih}</b> tarihinde doldu. `
            + (n > 0 ? `Paneliniz bitişten sonraki ${n} gün boyunca yalnız görüntüleme için açık kalır; bu sürede satış yapılamaz. ` : '')
            + `Verileriniz silinmez; lisansınızı yenilediğinizde kaldığınız yerden devam edersiniz. ${yenilemeYeri}`;
        break;
    }
    case 'deneme_2':
        konu = 'Deneme sürenizin bitmesine 2 gün kaldı';
        metin = `Ücretsiz deneme süreniz <b>${tarih}</b> tarihinde sona erecektir. Kullanmaya devam etmek için ihtiyacınıza uygun paketi seçebilirsiniz; deneme süresince girdiğiniz menü ve masa düzeni korunur. `
            + (smx ? 'Paket seçimi SofraMix işletme paneliniz üzerinden yapılır.' : 'Paket seçimini panelinizdeki Lisans sayfasından yapabilirsiniz.');
        break;
    case 'deneme_son':
        konu = 'Deneme süreniz bugün sona eriyor';
        metin = 'Ücretsiz deneme süreniz bugün sona eriyor. Kullanmaya kesintisiz devam etmek için paketinizi bugün seçebilirsiniz; girdiğiniz menü ve masa düzeni korunur. '
            + (smx ? 'Paket seçimi SofraMix işletme paneliniz üzerinden yapılır.' : 'Paket seçimini panelinizdeki Lisans sayfasından yapabilirsiniz.');
        break;
    default:
        return null;
    }
    const html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">'
        + '<h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>'
        + `<p style="color:#374151">Sayın ${esc(o.isletmeAdi || 'işletme')} yetkilisi,</p>`
        + `<p style="color:#374151">${metin}</p>`
        + `<p style="margin:20px 0"><a href="${esc(baglanti)}" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">${dugme}</a></p>`
        + '<p style="color:#6b7280;font-size:.85rem">Ödemenizi yaptıysanız bu e-postayı dikkate almayabilirsiniz. Sorularınız için bize yazabilirsiniz.</p>'
        + '<p style="color:#9ca3af;font-size:.8rem;margin-top:24px">Bu e-posta otomatik gönderilmiştir.</p></div>';
    return { konu: konu + ' - MDA Restoran POS', html, baglanti };
}

const EPOSTA_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function alicilar(tenantId) {
    const r = await query(
        "SELECT email FROM users WHERE tenant_id = ? AND role = 'OWNER' AND COALESCE(is_active, 1) = 1", [tenantId]);
    const set = new Set();
    for (const x of r.rows) {
        const e = String(x.email || '').trim().toLowerCase();
        if (EPOSTA_RE.test(e) && !e.endsWith('@ornek.local')) set.add(e);
    }
    return [...set];
}

async function bekleyenOdemeVarMi(tenantId) {
    const r = await query(
        "SELECT 1 FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede' AND odeme_bildirildi_at IS NOT NULL LIMIT 1", [tenantId]);
    return r.rows.length > 0;
}

// Bir tur. gonder(alici, konu, html) -> true/false (test icin degistirilebilir). Doner: { gonderilen: [...] }
async function tara({ simdi = new Date(), gonder, saatKontrolu = true } = {}) {
    const ayar = require('./yonetimAyar');
    if (!ayar.hatirlatmaAcik()) return { atlandi: 'ayar_kapali', gonderilen: [] };
    if (saatKontrolu && !gonderimSaatiMi(simdi)) return { atlandi: 'saat_disi', gonderilen: [] };
    const postala = gonder || (async (to, subject, html) => {
        const r = await require('./emailService').sendMail({ to, subject, html });
        return !!(r && r.sent);
    });
    const r = await query(
        `SELECT id, business_name, license_tier, license_end_date, parent_org
           FROM tenants WHERE is_active = 1 AND license_end_date IS NOT NULL`);
    const gonderilen = [];
    for (const t of r.rows) {
        try {
            const tur = hatirlatmaTuru(t, simdi);
            if (!tur) continue;
            if (await bekleyenOdemeVarMi(t.id)) continue;
            const kime = await alicilar(t.id);
            if (!kime.length) continue;
            const ic = icerik({ tur, isletmeAdi: t.business_name, bitis: t.license_end_date, sofraMix: sofraMixMi(t),
                toleransGun: ayar.toleransGun() });
            if (!ic) continue;
            // Once yer ayir (UNIQUE): ayni anda iki tarama ya da onceki gonderim varsa ikinci kez gitmez
            const yer = await query(
                'INSERT OR IGNORE INTO lisans_hatirlatmalari (tenant_id, tur, bitis, alicilar) VALUES (?, ?, ?, ?)',
                [t.id, tur, String(t.license_end_date), kime.join(',')]);
            if (!yer.changes) continue;
            let basarili = 0;
            for (const a of kime) {
                try { if (await postala(a, ic.konu, ic.html)) basarili++; } catch (_) { /* digerine devam */ }
            }
            if (!basarili) {
                // Hic gidemediyse kaydi geri al: sonraki saatte (ayni gun icinde) yeniden denenir
                await query('DELETE FROM lisans_hatirlatmalari WHERE tenant_id = ? AND tur = ? AND bitis = ?',
                    [t.id, tur, String(t.license_end_date)]);
                continue;
            }
            gonderilen.push({ tenantId: t.id, tur, adet: basarili });
        } catch (e) { console.error('[lisans-hatirlatma]', t.id, e.message); }
    }
    if (gonderilen.length) console.log(`[lisans-hatirlatma] ${gonderilen.length} isletmeye hatirlatma gonderildi`);
    return { gonderilen };
}

let suren = null, ilkZaman = null, aralik = null;
function calistir() {
    if (suren) return suren;
    suren = tara().catch((e) => console.error('[lisans-hatirlatma] tarama:', e.message)).finally(() => { suren = null; });
    return suren;
}

const smtpVarMi = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function baslat() {
    if (ilkZaman || aralik) return;
    if (!smtpVarMi()) { console.log('[lisans-hatirlatma] SMTP tanimli degil - hatirlatma e-postalari kapali'); return; }
    ilkZaman = setTimeout(calistir, ILK_GECIKME_MS);
    aralik = setInterval(calistir, ARALIK_MS);
}

function durdur() {
    clearTimeout(ilkZaman); clearInterval(aralik);
    ilkZaman = null; aralik = null;
}

module.exports = {
    istanbulGun, istanbulSaat, gunFarki, gonderimSaatiMi, hatirlatmaTuru, sofraMixMi, icerik, alicilar, tara,
    baslat, durdur, ARALIK_MS,
};
