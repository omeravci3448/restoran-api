// --- Isletmeye lisans e-postasi: odeme onaylandi / onaylanmadi (Patron karari 2026-11-18) ---
// Alici: isletmenin SAHIP (OWNER) hesaplarinin e-postalari + tenants.owner_email (tekil). SMTP tanimli degilse
// sessizce atlanir (gelistirme ortaminda konsola da yazilmaz). Best-effort: posta gitmese de onay/red bozulmaz;
// musteri sonucu Lisans sayfasinda zaten gorur.
// Vergi / TC kimlik numarasi e-postaya YAZILMAZ.

const { query } = require('../config/db');
const { esc } = require('./rootBildirim');

const smtpVar = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const EPOSTA_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function alicilar(tenantId) {
    const t = (await query('SELECT business_name, owner_email FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return { ad: '', liste: [] };
    const u = await query("SELECT email FROM users WHERE tenant_id = ? AND role = 'OWNER' AND is_active = 1", [tenantId]);
    const liste = [];
    for (const e of [t.owner_email, ...u.rows.map((x) => x.email)]) {
        const s = String(e || '').trim().toLowerCase();
        if (s && EPOSTA_RE.test(s) && !liste.includes(s)) liste.push(s);
    }
    return { ad: t.business_name || '', liste };
}

function govde(baslik, paragraflar) {
    const panel = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
    return '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;padding:16px;border:1px solid #e5e7eb;border-radius:12px">'
        + '<h2 style="color:#E2622A;margin:0 0 10px">' + esc(baslik) + '</h2>'
        + paragraflar.map((p) => '<p style="margin:6px 0;color:#374151;line-height:1.5">' + esc(p) + '</p>').join('')
        + '<p style="margin-top:14px"><a href="' + panel + '/lisans" style="background:#E2622A;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">Lisans sayfasını aç</a></p>'
        + '<p style="color:#9ca3af;font-size:.8rem;margin-top:18px">Bu e-posta MDA Restoran POS tarafından otomatik gönderilmiştir.</p></div>';
}

async function gonder(tenantId, konu, baslik, paragraflar) {
    try {
        if (!smtpVar()) return;
        const { ad, liste } = await alicilar(tenantId);
        if (!liste.length) return;
        const { sendMail } = require('./emailService');
        const html = govde(baslik, ad ? [`Sayın ${ad} yetkilisi,`, ...paragraflar] : paragraflar);
        const k = String(konu).replace(/[\r\n]+/g, ' ').slice(0, 160);
        for (const to of liste) await sendMail({ to, subject: k, html }).catch(() => {});
    } catch (_) { /* bildirim yan is */ }
}

// paket: musteriye gorunen paket adi; bitis: Date | ISO
function onaylandi(tenantId, { paket, bitis }) {
    const tarih = bitis ? new Date(bitis).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '-';
    return gonder(tenantId, 'Paketiniz onaylandı - MDA Restoran POS', 'Paketiniz onaylandı', [
        `Paketiniz onaylandı: ${paket}. Lisansınız ${tarih} tarihine kadar geçerlidir.`,
        'Seçtiğiniz modüller hesabınızda etkinleşmiştir. İyi çalışmalar dileriz.',
    ]);
}

function reddedildi(tenantId, { sebep }) {
    return gonder(tenantId, 'Ödeme bildiriminiz onaylanmadı - MDA Restoran POS', 'Ödeme bildiriminiz onaylanmadı', [
        `Açıklama: ${sebep}`,
        'Ödemeyi yaptıysanız bizimle iletişime geçin; dilerseniz Lisans sayfasından yeni bir seçimle yeniden satın alabilirsiniz.',
    ]);
}

// Root "Ek süre tanımla" (rakipten gecis): eklenen gun ve yeni bitis
function ekSure(tenantId, { gun, bitis }) {
    const tarih = bitis ? new Date(bitis).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
    return gonder(tenantId, 'Ek lisans süreniz tanımlandı - MDA Restoran POS', 'Ek lisans süreniz tanımlandı', [
        `Ek lisans süreniz tanımlanmıştır: ${gun} gün. Yeni bitiş tarihiniz: ${tarih}.`,
        'Paketiniz ve modülleriniz değişmeden devam eder. İyi çalışmalar dileriz.',
    ]);
}

module.exports = { onaylandi, reddedildi, ekSure, alicilar };
