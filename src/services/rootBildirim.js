// ——— Patron'a (root) e-posta bildirimi ———
// Odeme bildirimi, "odemeyi yaptim", yeni restoran kaydi, SofraMix'ten paket alimi.
// Alici: root ayari bildirim_eposta, yoksa ROOT_EMAIL. Best-effort: posta gitmese de asil akis
// bozulmaz; her olay root panelinde zaten gorunur.
//
// Degerler HTML'e KACISLANARAK yazilir: isletme adi, e-posta gibi alanlar herkese acik kayit
// formundan geliyor; kacislanmasaydi biri isletme adina baglanti/etiket yazip Patron'un
// gelen kutusuna sahte bir buton koyabilirdi.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function rootaBildir(konu, satirlar, secenek = {}) {
    try {
        const A = require('./sistemAyar');
        const alici = (await A.oku('bildirim_eposta', '')) || process.env.ROOT_EMAIL || '';
        if (!alici) return;
        const { sendMail } = require('./emailService');
        const panel = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
        const dugme = secenek.dugme || 'Root paneli > Ödeme Bildirimleri';
        const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;padding:16px;border:1px solid #e5e7eb;border-radius:12px">'
            + '<h2 style="color:#E2622A;margin:0 0 10px">' + esc(konu) + '</h2>'
            + satirlar.map(([k, v]) => '<div style="margin:2px 0"><b>' + esc(k) + ':</b> ' + esc(v) + '</div>').join('')
            + '<p style="margin-top:14px"><a href="' + panel + '/1453" style="background:#E2622A;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">'
            + esc(dugme) + '</a></p></div>';
        // Konu satirinda satir sonu olmasin (baslik enjeksiyonu)
        const baslik = '[MDA POS] ' + String(konu).replace(/[\r\n]+/g, ' ').slice(0, 160);
        await sendMail({ to: alici, subject: baslik, html }).catch(() => {});
    } catch (_) { /* bildirim yan is */ }
}

module.exports = { rootaBildir, esc };
