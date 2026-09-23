const { query } = require('../config/db');
const { odemeIsle, bekleyenElde } = require('./posProvizyon');
const { sendMail } = require('./emailService');

// ——— SofraMix POS odemelerini CEKME ———
// SofraMix'te POS paketi karti ile odenip onaylaninca, POS bu servisle periyodik
// olarak "benim icin onaylanmis yeni odeme var mi" diye SORAR.
//
// NEDEN CEKME (pull), BILDIRIM (push) DEGIL:
//   1. SofraMix tarafina kuyruk + tekrar deneme + imza dogrulama yazmak gerekmiyor;
//      sormanin kendisi zaten tekrar denemedir.
//   2. POS bakimdayken/kapaliyken bildirim kaybolmaz - acilinca ayni yerden devam eder.
//   3. "Para alindi ama POS acilmadi" sessiz hatasi imkansizlasir.
//   4. Disariya yeni bir kimliksiz uc acmiyoruz (silinen lisans webhook'unun hatasi).

const URL_TABAN = (process.env.SOFRAMIX_PLATFORM_URL || '').replace(/\/+$/, '');
const ANAHTAR = process.env.SOFRAMIX_PLATFORM_ANAHTAR || '';
const ARALIK_SN = Number(process.env.POS_PROVIZYON_ARALIK_SN || 180);
const PANEL_URL = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
const UYARI_EPOSTA = process.env.PROVIZYON_UYARI_EPOSTA || process.env.DEMO_TALEP_MAIL || '';

// GENIS TUR: en son odemeden bu kadar geriye donup tekrar sorar. Saat farki veya
// gec onaylanmis bir odeme atlanmasin diye. AMA her turda genis sormuyoruz:
// SofraMix veri ciktigi HER istekte KVKK aktarim kaydi yaziyor, 3 dakikada bir
// ayni kayitlari cekmek o defteri anlamsiz kilardi. Bu yuzden normal turlarda
// imlec tam olarak son odemenin 1 saniye sonrasi, genis tur ise saatte bir.
const CAKISMA_SAAT = Number(process.env.POS_PROVIZYON_CAKISMA_SAAT || 6);
const GENIS_ARALIK_DK = Number(process.env.POS_PROVIZYON_GENIS_ARALIK_DK || 60);
// Ilk calistirmada ne kadar geriye bakilacak. SofraMix 400 gune kadar izin
// veriyor; dar tutmak "kurulumdan once satilmis paketleri hic gormeme" riski
// yaratir, genis tutmanin maliyeti ise yok (odeme_id zaten tekillestiriyor).
const ILK_GUN = Number(process.env.POS_PROVIZYON_ILK_GUN || 90);

// Kendiliginden DUZELMEYECEK hatalar. Bunlarda beklemenin anlami yok, hemen haber ver.
const KALICI_KODLAR = [400, 401, 403, 404];
const UST_USTE_UYARI_SINIRI = Number(process.env.PROVIZYON_UYARI_SINIRI || 5);

const durumu = {
    sonBasarili: null, sonHata: null, sonHataAt: null,
    ustUsteHata: 0, uyariGonderildi: false, sonGenisTur: 0,
};

function acikMi() { return Boolean(URL_TABAN && ANAHTAR); }
function yarimYapilandirma() { return Boolean(URL_TABAN) !== Boolean(ANAHTAR); }

// Nereden devam edecegiz? Ayri bir imlec tablosu TUTMUYORUZ: en son islenen
// odemenin tarihi zaten imlecin kendisi. Boylece imlec ile gercek durum
// birbirinden ayrisip "imlec ilerledi ama kayit yok" hatasi olusamaz.
async function nereden(genis = false) {
    const r = await query('SELECT MAX(onay_tarihi) AS son FROM pos_provizyon');
    const son = r.rows[0] && r.rows[0].son;
    if (!son) return new Date(Date.now() - ILK_GUN * 86400000).toISOString();
    // SofraMix filtresi ">= since" oldugu icin tam MAX gonderirsek son kayit her
    // turda tekrar doner (ve KVKK defterine tekrar yazilir). 1 saniye ileri
    // atiyoruz; ayni saniyede iki odeme olma ihtimalini de saatte bir calisan
    // genis tur zaten topluyor.
    const taban = genis
        ? new Date(son).getTime() - CAKISMA_SAAT * 3600000
        : new Date(son).getTime() + 1000;
    return new Date(taban).toISOString();
}

async function odemeleriGetir(since) {
    const u = `${URL_TABAN}/api/platform/pos-odemeleri?since=${encodeURIComponent(since)}`;
    const c = new AbortController();
    const zaman = setTimeout(() => c.abort(), 20000);
    try {
        const y = await fetch(u, {
            headers: { 'X-Smx-Platform-Anahtar': ANAHTAR, Accept: 'application/json' },
            signal: c.signal,
        });
        if (!y.ok) {
            const govde = await y.text().catch(() => '');
            const e = new Error(`SofraMix ${y.status}${govde ? ' - ' + govde.slice(0, 200) : ''}`);
            e.kod = y.status;
            e.kalici = KALICI_KODLAR.includes(y.status);
            throw e;
        }
        const j = await y.json();
        return Array.isArray(j) ? j : (j.odemeler || j.data || []);
    } finally { clearTimeout(zaman); }
}

function postaKabugu(icerik) {
    return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>${icerik}</div>`;
}

function aktivasyonPostasi({ ad, baglanti, isyeriKodu, lisansBitis }) {
    const bitis = lisansBitis ? new Date(lisansBitis).toLocaleDateString('tr-TR') : '';
    return postaKabugu(`
        <p style="color:#374151">Merhaba ${ad},</p>
        <p style="color:#374151">POS paketiniz tanimlandi. Asagidaki baglantidan sifrenizi belirleyip kullanmaya baslayabilirsiniz.</p>
        <p style="margin:20px 0"><a href="${baglanti}" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Sifremi belirle</a></p>
        <p style="color:#374151;font-size:.92rem">Isyeri kodunuz: <b>${isyeriKodu || '-'}</b>${bitis ? ` &middot; Lisans bitisi: <b>${bitis}</b>` : ''}</p>
        <p style="color:#6b7280;font-size:.85rem">Bu baglanti 72 saat gecerlidir. Suresi gecerse bize yazin, yenisini gonderelim.</p>
        <hr style="border:0;border-top:1px solid #eee;margin:18px 0">
        <p style="color:#374151;font-size:.92rem"><b>Menunuzu SofraMix'ten cekmek icin</b><br>
        1) SofraMix isletme panelinde <b>Ayarlar &rarr; Baglanti anahtarlari</b>'ndan bir anahtar uretin (bir kez gorunur, kopyalayin).<br>
        2) POS'ta <b>Ayarlar &rarr; Satis kanallari</b>'nda SofraMix kanalini acip anahtari ve SofraMix isletme numaranizi yapistirin.<br>
        3) <b>Menu</b> sayfasinda "SofraMix'ten menuyu cek" dugmesine basin. Fiyatlar 0 gelir, salon fiyatlarinizi siz girersiniz.</p>`);
}

function yenilemePostasi({ ad, lisansBitis, isyeriKodu }) {
    const bitis = lisansBitis ? new Date(lisansBitis).toLocaleDateString('tr-TR') : '';
    return postaKabugu(`
        <p style="color:#374151">Merhaba ${ad},</p>
        <p style="color:#374151">POS lisansiniz yenilendi. Yeni bitis tarihi: <b>${bitis}</b>.</p>
        <p style="color:#374151;font-size:.92rem">Isyeri kodunuz: <b>${isyeriKodu || '-'}</b>. Mevcut sifrenizle girmeye devam edebilirsiniz.</p>
        <p style="color:#6b7280;font-size:.85rem">Bu yenilemeyi siz yapmadiysaniz hemen bize yazin.</p>`);
}

async function uyar(konu, metin) {
    console.error(`[provizyon] UYARI: ${konu} - ${metin}`);
    if (!UYARI_EPOSTA) return;
    await sendMail({ to: UYARI_EPOSTA, subject: `MDA POS provizyon: ${konu}`,
        html: postaKabugu(`<p style="color:#b91c1c"><b>${konu}</b></p><p style="color:#374151">${metin}</p>`) })
        .catch((e) => console.error('[provizyon] uyari postasi gonderilemedi:', e.message));
}

// Tek tur: cek, isle, yeni acilan/yenilenen isletmelere posta gonder.
async function birTur({ genis } = {}) {
    if (!acikMi()) return { acik: false };
    const genisMi = genis !== undefined ? genis
        : (Date.now() - durumu.sonGenisTur > GENIS_ARALIK_DK * 60000);
    const since = await nereden(genisMi);

    let liste;
    try {
        liste = await odemeleriGetir(since);
        durumu.ustUsteHata = 0;
        durumu.sonBasarili = new Date().toISOString();
        durumu.uyariGonderildi = false;
        if (genisMi) durumu.sonGenisTur = Date.now();
    } catch (e) {
        durumu.ustUsteHata++;
        durumu.sonHata = e.message;
        durumu.sonHataAt = new Date().toISOString();
        // Kalici hatada (anahtar iptal edilmis, kapsam yok, adres yanlis) beklemek
        // anlamsiz - bu kendiliginden duzelmez. Gecici hatada ust uste N turdan
        // sonra haber ver ki gecici bir kesinti her seferinde e-posta yagdirmasin.
        if ((e.kalici || durumu.ustUsteHata >= UST_USTE_UYARI_SINIRI) && !durumu.uyariGonderildi) {
            durumu.uyariGonderildi = true;
            await uyar(e.kalici ? 'SofraMix baglantisi KALICI olarak kirik' : 'SofraMix sorgusu ust uste basarisiz',
                `${e.message}. Son basarili tur: ${durumu.sonBasarili || 'hic'}. ` +
                (e.kalici ? 'Platform anahtari iptal edilmis ya da adres yanlis olabilir - elle kontrol gerekiyor.'
                    : `Ust uste ${durumu.ustUsteHata} tur basarisiz.`));
        }
        throw e;
    }

    const ozet = { acik: true, genis: genisMi, since, gelen: liste.length,
        islenen: 0, zaten: 0, acilan: 0, yenilenen: 0, elde: 0, hata: 0 };

    for (const o of liste) {
        try {
            const s = await odemeIsle(o);
            if (s.durum === 'zaten_islendi') { ozet.zaten++; continue; }
            if (s.durum === 'elde') { ozet.elde++; continue; }
            if (s.durum !== 'islendi') { ozet.hata++; continue; }
            ozet.islenen++;

            const alici = s.eposta || o.yetkili_email;
            if (s.kiraciAcildi && s.aktivasyonJetonu && alici) {
                ozet.acilan++;
                await postaDene(alici, 'MDA Restoran POS hesabiniz hazir', aktivasyonPostasi({
                    ad: o.isletme_adi || 'Isletme',
                    baglanti: `${PANEL_URL}/aktivasyon/${s.aktivasyonJetonu.ham}`,
                    isyeriKodu: s.isyeriKodu, lisansBitis: s.lisansBitis,
                }), s.tenantId);
            } else if (s.lisansUzatildi && alici) {
                // Lisans SESSIZCE uzamamali: isletme odedigi paranin karsiligini
                // gordugunu bilmeli, yanlis kiraciya yazilmissa da hemen fark edilsin.
                ozet.yenilenen++;
                await postaDene(alici, 'POS lisansiniz yenilendi', yenilemePostasi({
                    ad: o.isletme_adi || 'Isletme', lisansBitis: s.lisansBitis, isyeriKodu: s.isyeriKodu,
                }), s.tenantId);
                if (s.esles === 'eposta') {
                    await uyar('Lisans yalnizca E-POSTA eslesmesiyle uzatildi',
                        `Odeme ${o.odeme_id} icin SofraMix isletme numarasi veya telefon eslesmedi; ` +
                        `yalnizca ${alici} adresiyle tek bir kiraci bulundu ve ona 1 yil yazildi. ` +
                        `Yanlis isletme olma ihtimaline karsi kontrol edin.`);
                }
            }
        } catch (e) {
            ozet.hata++;
            console.error('[provizyon] odeme islenemedi', o && o.odeme_id, e.message);
        }
    }

    // Elle cozulmeyi bekleyen odemeler HER TURDA raporlanir. Eskiden 'elde'
    // birakilan bir odeme yalniz ilk turda gorunur, sonra sessizce kaybolurdu.
    const bekleyen = await bekleyenElde();
    ozet.bekleyenElde = bekleyen.adet || 0;
    if (ozet.elde > 0) {
        await uyar('Elle cozulmesi gereken odeme var',
            `${ozet.elde} odeme bu turda elde birakildi, toplam bekleyen: ${ozet.bekleyenElde}. ` +
            `Root panelinde /1453 > Provizyon ekranindan bakin. Para alindi ama lisans acilmadi.`);
    }
    return ozet;
}

// Posta gonderimi BASARISIZ olabilir (SMTP kapali, gecici hata). Eskiden hata
// yutuluyordu: kiraci acilmis, jeton uretilmis ama kimseye ulasmamisti ve
// 72 saat sonra jeton oluyordu. Simdi basarisiz gonderim kayda gecer ve root
// panelinden yeniden gonderilebilir.
async function postaDene(alici, konu, html, tenantId) {
    try {
        const r = await sendMail({ to: alici, subject: konu, html });
        if (r && r.sent) return true;
        await query("UPDATE pos_provizyon SET hata = ? WHERE tenant_id = ? AND durum = 'islendi'",
            [`Posta gonderilemedi (${alici}) - root panelinden yeniden gonderin.`, tenantId]);
        await uyar('Aktivasyon postasi gonderilemedi',
            `${alici} adresine "${konu}" gonderilemedi${r && r.dev ? ' (SMTP tanimli degil)' : ''}. ` +
            `Root panelinde /1453 > Provizyon ekranindan yeniden gonderin.`);
        return false;
    } catch (e) {
        console.error('[provizyon] posta:', e.message);
        return false;
    }
}

let calisiyor = false;
let zamanlayici = null;

async function tikla() {
    if (calisiyor) return;              // ust uste binmesin
    calisiyor = true;
    try {
        const o = await birTur();
        if (o.acik && (o.islenen || o.elde || o.hata || o.bekleyenElde)) console.log('[provizyon]', JSON.stringify(o));
    } catch (e) {
        console.error('[provizyon] tur hatasi:', e.message);
    } finally { calisiyor = false; }
}

function baslat() {
    // Yarim yapilandirma SESSIZ KALMAMALI: bu neredeyse her zaman yazim hatasidir
    // ve "neden hic odeme gelmiyor" diye gunlerce aranan seydir.
    if (yarimYapilandirma()) {
        console.error('[provizyon] EKSIK YAPILANDIRMA: ' +
            (URL_TABAN ? 'SOFRAMIX_PLATFORM_ANAHTAR' : 'SOFRAMIX_PLATFORM_URL') +
            ' tanimli degil - provizyon KAPALI kalacak, odemeler islenmeyecek.');
        return null;
    }
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

// Root panelinde "baglanti saglikli mi" sorusunun cevabi.
function saglik() {
    return { acik: acikMi(), yarim: yarimYapilandirma(), url: URL_TABAN || null,
        aralikSn: ARALIK_SN, ...durumu, sonGenisTur: durumu.sonGenisTur || null };
}

module.exports = { baslat, durdur, birTur, tikla, acikMi, nereden, saglik, postaDene };
