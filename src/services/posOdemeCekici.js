const { query } = require('../config/db');
const { odemeIsle } = require('./posProvizyon');
const { sendMail } = require('./emailService');

// ——— SofraMix POS odemelerini CEKME ———
// SofraMix'te POS paketi karti ile odenip onaylaninca, POS bu servisle periyodik
// olarak "benim icin onaylanmis yeni odeme var mi" diye SORAR.
//
// NEDEN CEKME (pull), BILDIRIM (push) DEGIL:
//   1. SofraMix tarafina kuyruk + tekrar deneme + imza dogrulama yazmak gerekmiyor;
//      sormanin kendisi zaten tekrar denemedir.
//   2. POS bakimdayken/kapaliyken bildirim kaybolmaz - acilinca ayni yerden devam eder.
//   3. "Para alindi ama POS acilmadi" sessiz hatasi imkansizlasir: odeme listede
//      duruyorsa er gec islenir.
//   4. Disariya yeni bir kimliksiz uc acmiyoruz (silinen lisans webhook'unun hatasi).

const URL_TABAN = process.env.SOFRAMIX_PLATFORM_URL || '';
const ANAHTAR = process.env.SOFRAMIX_PLATFORM_ANAHTAR || '';
const ARALIK_SN = Number(process.env.POS_PROVIZYON_ARALIK_SN || 180);
const PANEL_URL = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
// Cakisma penceresi: en son odemeden bu kadar geriye donup tekrar soruyoruz.
// Ayni odeme tekrar gelse bile odeme_id benzersiz oldugu icin iki kez islenmez;
// bu pencere sadece saat farki/gecikmeli onay yuzunden odeme ATLAMAYI onler.
const CAKISMA_SAAT = Number(process.env.POS_PROVIZYON_CAKISMA_SAAT || 6);
const ILK_GUN = Number(process.env.POS_PROVIZYON_ILK_GUN || 7);

function acikMi() { return Boolean(URL_TABAN && ANAHTAR); }

// Nereden devam edecegiz? Ayri bir imlec tablosu TUTMUYORUZ: en son islenen
// odemenin tarihi zaten imlecin kendisi. Boylece imlec ile gercek durum
// birbirinden ayrisip "imlec ilerledi ama kayit yok" hatasi olusamaz.
async function nereden() {
    const r = await query('SELECT MAX(onay_tarihi) AS son FROM pos_provizyon');
    const son = r.rows[0] && r.rows[0].son;
    const taban = son ? new Date(son).getTime() - CAKISMA_SAAT * 3600000
        : Date.now() - ILK_GUN * 86400000;
    return new Date(taban).toISOString();
}

async function odemeleriGetir(since) {
    const u = `${URL_TABAN.replace(/\/+$/, '')}/api/platform/pos-odemeleri?since=${encodeURIComponent(since)}`;
    const c = new AbortController();
    const zaman = setTimeout(() => c.abort(), 20000);
    try {
        const y = await fetch(u, {
            headers: { 'X-Smx-Platform-Anahtar': ANAHTAR, Accept: 'application/json' },
            signal: c.signal,
        });
        if (!y.ok) throw new Error(`SofraMix ${y.status}`);
        const j = await y.json();
        return Array.isArray(j) ? j : (j.odemeler || j.data || []);
    } finally { clearTimeout(zaman); }
}

function aktivasyonPostasi({ ad, baglanti, isyeriKodu, lisansBitis }) {
    const bitis = lisansBitis ? new Date(lisansBitis).toLocaleDateString('tr-TR') : '';
    return `
    <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>
        <p style="color:#374151">Merhaba ${ad},</p>
        <p style="color:#374151">POS paketiniz tanimlandi. Asagidaki baglantidan sifrenizi belirleyip kullanmaya baslayabilirsiniz.</p>
        <p style="margin:20px 0"><a href="${baglanti}" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Sifremi belirle</a></p>
        <p style="color:#374151;font-size:.92rem">Isyeri kodunuz: <b>${isyeriKodu || '-'}</b>${bitis ? ` &middot; Lisans bitisi: <b>${bitis}</b>` : ''}</p>
        <p style="color:#6b7280;font-size:.85rem">Bu baglanti 72 saat gecerlidir. Suresi gecerse giris ekranindan "sifremi unuttum" diyebilirsiniz.</p>
    </div>`;
}

// Tek tur: cek, isle, yeni acilan isletmelere aktivasyon postasi gonder.
async function birTur() {
    if (!acikMi()) return { acik: false };
    const since = await nereden();
    const liste = await odemeleriGetir(since);
    const ozet = { acik: true, since, gelen: liste.length, islenen: 0, zaten: 0, acilan: 0, elde: 0, hata: 0 };

    for (const o of liste) {
        try {
            const s = await odemeIsle(o);
            if (s.durum === 'zaten_islendi') { ozet.zaten++; continue; }
            if (s.durum === 'elde') { ozet.elde++; continue; }
            if (s.durum !== 'islendi') { ozet.hata++; continue; }
            ozet.islenen++;
            if (s.kiraciAcildi && s.aktivasyonJetonu && o.yetkili_email) {
                ozet.acilan++;
                await sendMail({
                    to: o.yetkili_email,
                    subject: 'MDA Restoran POS hesabiniz hazir',
                    html: aktivasyonPostasi({
                        ad: o.isletme_adi || 'Isletme',
                        baglanti: `${PANEL_URL}/aktivasyon/${s.aktivasyonJetonu.ham}`,
                        isyeriKodu: s.isyeriKodu, lisansBitis: s.lisansBitis,
                    }),
                }).catch((e) => console.error('[provizyon] posta:', e.message));
            }
        } catch (e) {
            ozet.hata++;
            console.error('[provizyon] odeme islenemedi', o && o.odeme_id, e.message);
        }
    }
    return ozet;
}

let calisiyor = false;
let zamanlayici = null;

async function tikla() {
    if (calisiyor) return;              // ust uste binmesin
    calisiyor = true;
    try {
        const o = await birTur();
        if (o.acik && (o.islenen || o.elde || o.hata)) console.log('[provizyon]', JSON.stringify(o));
    } catch (e) {
        console.error('[provizyon] tur hatasi:', e.message);
    } finally { calisiyor = false; }
}

function baslat() {
    if (!acikMi()) {
        console.log('[provizyon] kapali - SOFRAMIX_PLATFORM_URL/ANAHTAR tanimli degil');
        return null;
    }
    if (zamanlayici) return zamanlayici;
    zamanlayici = setInterval(tikla, ARALIK_SN * 1000);
    if (zamanlayici.unref) zamanlayici.unref();
    setTimeout(tikla, 15000).unref?.();  // acilista biraz bekle, DB hazir olsun
    console.log(`[provizyon] acik - her ${ARALIK_SN} sn'de bir SofraMix sorulacak`);
    return zamanlayici;
}

function durdur() { if (zamanlayici) { clearInterval(zamanlayici); zamanlayici = null; } }

module.exports = { baslat, durdur, birTur, tikla, acikMi, nereden };
