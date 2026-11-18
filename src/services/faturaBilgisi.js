// --- Fatura bilgisi (Patron karari 2026-11-18: ilk satin almada BIR KEZ zorunlu) ---
// Kolonlar tenants tablosunda (kayit formu ve Ayarlar ayni alanlari yazar):
//   billing_name        Fatura unvani / ad soyad
//   billing_tax_id      yalniz rakam: 10 hane = VKN (vergi no), 11 hane = TCKN
//   billing_tax_office  vergi dairesi (VKN ise zorunlu)
//   billing_address     fatura adresi
// Satin alma bilgiler eksikse 400 FATURA_BILGISI_EKSIK doner. Guncelleme ucu /api/license/fatura altinda: lisans
// uclari SALT_OKUNUR ve KAPALI durumda da acik (lisansDurumu.YAZMAYA_IZINLI / KAPALIDA_ACIK), ek kural gerekmez.
// ⚠ Vergi / TC kimlik numarasi gunluge, yonetim gunlugune ve e-posta konusuna YAZILMAZ.

const { query } = require('../config/db');

const SINIR = { ad: 200, daire: 100, adres: 400 };
const temiz = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const rakam = (s) => String(s == null ? '' : s).replace(/[\s.-]/g, '');

function hata(message, alan) { return Object.assign(new Error(message), { status: 400, code: 'FATURA_BILGISI_GECERSIZ', alan }); }

// Kayitli bilgi -> eksik alan listesi ([] = tamam)
function eksikler(t) {
    const e = [];
    if (temiz(t && t.billing_name).length < 2) e.push('billing_name');
    const no = rakam(t && t.billing_tax_id);
    if (!/^\d{10}$/.test(no) && !/^[1-9]\d{10}$/.test(no)) e.push('billing_tax_id');
    if (/^\d{10}$/.test(no) && temiz(t && t.billing_tax_office).length < 2) e.push('billing_tax_office');
    if (temiz(t && t.billing_address).length < 5) e.push('billing_address');
    return e;
}

async function oku(tenantId) {
    const t = (await query(
        'SELECT billing_name, billing_tax_id, billing_tax_office, billing_address FROM tenants WHERE id = ?', [tenantId])).rows[0] || {};
    const eksik = eksikler(t);
    return {
        billingName: t.billing_name || '', billingTaxId: t.billing_tax_id || '', billingTaxOffice: t.billing_tax_office || '',
        billingAddress: t.billing_address || '', tamam: eksik.length === 0, eksik,
    };
}

// Govdeyi dogrular; hata varsa HICBIR sey yazilmadan 400 firlatir
function dogrula(g) {
    const ad = temiz(g.billingName);
    const no = rakam(g.billingTaxId);
    const daire = temiz(g.billingTaxOffice);
    const adres = temiz(g.billingAddress);
    if (ad.length < 2) throw hata('Fatura unvanı ya da ad soyad yazın.', 'billingName');
    if (ad.length > SINIR.ad) throw hata(`Fatura unvanı en fazla ${SINIR.ad} karakter olabilir.`, 'billingName');
    if (!/^\d+$/.test(no) || (no.length !== 10 && no.length !== 11)) {
        throw hata('Vergi numarası 10 haneli, TC kimlik numarası 11 haneli olmalı ve yalnız rakam içermeli.', 'billingTaxId');
    }
    if (no.length === 11 && no[0] === '0') throw hata('TC kimlik numarası 0 ile başlayamaz.', 'billingTaxId');
    if (no.length === 10 && daire.length < 2) throw hata('Vergi numarası için vergi dairesini yazın.', 'billingTaxOffice');
    if (daire.length > SINIR.daire) throw hata(`Vergi dairesi en fazla ${SINIR.daire} karakter olabilir.`, 'billingTaxOffice');
    if (adres.length < 5) throw hata('Fatura adresini yazın.', 'billingAddress');
    if (adres.length > SINIR.adres) throw hata(`Fatura adresi en fazla ${SINIR.adres} karakter olabilir.`, 'billingAddress');
    return { ad, no, daire: daire || null, adres };
}

async function yaz(tenantId, govde) {
    const v = dogrula(govde || {});
    await query(
        'UPDATE tenants SET billing_name = ?, billing_tax_id = ?, billing_tax_office = ?, billing_address = ? WHERE id = ?',
        [v.ad, v.no, v.daire, v.adres, tenantId]);
    return oku(tenantId);
}

module.exports = { eksikler, oku, dogrula, yaz };
