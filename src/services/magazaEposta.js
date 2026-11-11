const { query } = require('../config/db');
const { esc } = require('./rootBildirim');

// --- Magaza: isletmeye siparis durumu e-postasi ---
// Ne zaman: odeme alindi, kargoya verildi (firma + takip no), reddedildi (sebep), otomatik iptal (sebep).
// Alici: isletmenin owner_email adresi (bos / gecersiz / @ornek.local ise gonderilmez, gunluge yazilir).
// Tasiyici: emailService.sendMail (rootBildirim ile ayni SMTP; SMTP tanimsizsa yalniz gunluge yazar).
// Gonderim YAN istir: hata hicbir zaman siparis akisini durdurmaz, yalniz gunluge yazilir.
// Test icin tasiyici tasiyiciAyarla({ sendMail }) ile degistirilebilir (null = gercek tasiyici).
// Degerler HTML'e kacislanarak yazilir (isletme adi, kargo firmasi, sebep serbest metin).

let tasiyici = null;
function tasiyiciAyarla(t) { tasiyici = t || null; }

const panel = () => (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
const noMetin = (no) => 'MG-' + no;
const gecerliEposta = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/@ornek\.local$/i.test(e);

const SABLON = {
    ODEME_ALINDI: (s) => ({
        konu: `Sipariş ${noMetin(s.no)}: ödemeniz alındı`,
        satirlar: [`${noMetin(s.no)} numaralı mağaza siparişinizin ödemesi alınmıştır. Siparişiniz hazırlanmaya başlanacaktır.`],
        bilgiler: [],
    }),
    KARGODA: (s) => ({
        konu: `Sipariş ${noMetin(s.no)} kargoya verildi`,
        satirlar: [`${noMetin(s.no)} numaralı mağaza siparişiniz kargoya verilmiştir.`],
        bilgiler: [['Kargo firması', s.kargo_firma], ['Takip numarası', s.kargo_takip_no]],
    }),
    REDDEDILDI: (s) => ({
        konu: `Sipariş ${noMetin(s.no)} reddedildi`,
        satirlar: [`${noMetin(s.no)} numaralı mağaza siparişiniz reddedilmiştir.`],
        bilgiler: [['Sebep', s.kapanis_sebebi]],
    }),
    OTOMATIK_IPTAL: (s) => ({
        konu: `Sipariş ${noMetin(s.no)} iptal edildi`,
        satirlar: [`${noMetin(s.no)} numaralı mağaza siparişiniz iptal edilmiştir.`,
            'Ürünlere hâlâ ihtiyacınız varsa Mağaza bölümünden yeniden sipariş verebilirsiniz.'],
        bilgiler: [['Sebep', s.kapanis_sebebi]],
    }),
};
const TURLER = Object.keys(SABLON);

function govdeler({ isletme, satirlar, bilgiler, baglanti }) {
    const yol = 'Siparişinizi MDA Restoran POS panelinde Mağaza > Siparişlerim bölümünden izleyebilirsiniz.';
    const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;padding:20px;border:1px solid #e5e7eb;border-radius:12px;color:#1f2937">'
        + '<h2 style="color:#E2622A;margin:0 0 12px;font-size:18px">MDA Yazılım Mağaza</h2>'
        + '<p style="margin:0 0 10px">Sayın ' + esc(isletme) + ',</p>'
        + satirlar.map((x) => '<p style="margin:0 0 10px">' + esc(x) + '</p>').join('')
        + bilgiler.map(([k, v]) => '<div style="margin:2px 0"><b>' + esc(k) + ':</b> ' + esc(v) + '</div>').join('')
        + '<p style="margin:14px 0 6px">' + esc(yol) + '</p>'
        + '<p style="margin:12px 0"><a href="' + esc(baglanti) + '" style="background:#E2622A;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">Siparişi görüntüle</a></p>'
        + '<p style="color:#6b7280;font-size:12px;margin:16px 0 0">Bu e-posta otomatik olarak gönderilmiştir.</p></div>';
    const text = ['Sayın ' + isletme + ',', '', ...satirlar, ...bilgiler.map(([k, v]) => k + ': ' + v), '', yol, baglanti,
        '', 'Bu e-posta otomatik olarak gönderilmiştir.'].join('\n');
    return { html, text };
}

// Siparisin guncel kaydindan e-postayi kurar ve gonderir. Hicbir zaman hata firlatmaz.
async function durumBildir(siparisId, tur) {
    try {
        if (!TURLER.includes(tur)) return { gonderildi: false, sebep: 'TUR' };
        const s = (await query(
            `SELECT s.*, t.owner_email, t.business_name FROM magaza_siparisler s
               LEFT JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ?`, [String(siparisId)])).rows[0];
        if (!s) return { gonderildi: false, sebep: 'SIPARIS_YOK' };
        const alici = String(s.owner_email || '').trim();
        if (!gecerliEposta(alici)) {
            console.warn('[magaza] isletme e-postasi yok ya da gecersiz, bildirim atlandi:', s.tenant_id, noMetin(s.no));
            return { gonderildi: false, sebep: 'ALICI_YOK' };
        }
        const { konu, satirlar, bilgiler } = SABLON[tur](s);
        const { html, text } = govdeler({
            isletme: s.business_name || s.isletme_adi || 'İşletme', satirlar, bilgiler,
            baglanti: panel() + '/magaza?siparis=' + encodeURIComponent(s.id),
        });
        const gonderen = tasiyici || require('./emailService');
        const r = await gonderen.sendMail({ to: alici, subject: '[MDA Yazılım] ' + konu, html, text });
        if (r && r.sent === false && !r.dev) {
            console.error('[magaza] e-posta gonderilemedi:', noMetin(s.no), tur, r.error || 'bilinmeyen hata');
            return { gonderildi: false, sebep: 'GONDERIM', hata: r.error || null };
        }
        return { gonderildi: !!(r && r.sent), dev: !!(r && r.dev) };
    } catch (e) {
        console.error('[magaza] e-posta gonderilemedi:', siparisId, tur, e.message);
        return { gonderildi: false, sebep: 'GONDERIM', hata: e.message };
    }
}

module.exports = { TURLER, durumBildir, tasiyiciAyarla };
