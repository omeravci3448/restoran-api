const { query } = require('../config/db');
const { rootaBildir } = require('./rootBildirim');

// --- Magaza bildirimleri (Patron'a) ---
// Yeni siparis ve "odemeyi yaptim": rootaBildir (e-posta) + root_olaylar satiri. root_olaylar'i
// yonetim APK'si /api/root/cihaz/bildirim-durumu yanitindaki "olay" alanindan okur
// (yeniKayitIzleyici.telefonOzeti tum turleri doner). UNIQUE(tur, ref): ayni olay bir kez yazilir.
// Bildirim yan istir: hata asil akisi (siparis, odeme bildirimi) bozmaz.

const TUR = { SIPARIS: 'magaza_siparis', ODEME: 'magaza_odeme' };

const tl = (k) => (Number(k || 0) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
const noMetin = (no) => 'MG-' + no;

async function olayYaz(tur, ref, tenantId, baslik, detay) {
    const r = await query(
        'INSERT OR IGNORE INTO root_olaylar (tur, ref, tenant_id, baslik, detay) VALUES (?, ?, ?, ?, ?)',
        [tur, ref, tenantId || null, String(baslik || '').slice(0, 120), String(detay || '').slice(0, 300)]);
    return !!r.changes;
}

function urunOzeti(kalemler) {
    return kalemler.map(k => `${k.adet} x ${k.urun_adi || k.ad}`).join('; ').slice(0, 400);
}

async function yeniSiparis(s, kalemler) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        // APK 1.4 bildirim basligi: "Yeni restoran kaydı: <baslik>" (paket_alindi disi turler);
        // metin bu yuzden "Mağaza siparişi" ile baslar.
        const yeni = await olayYaz(TUR.SIPARIS, s.id, s.tenant_id, ad,
            `Mağaza siparişi ${noMetin(s.no)} · ${kalemler.length} kalem · ${tl(s.genel_toplam_kurus)} · havale/EFT bekleniyor`);
        if (!yeni) return;
        await rootaBildir('Mağaza siparişi: ' + ad, [
            ['İşletme', ad + (s.isyeri_kodu ? ' (kod ' + s.isyeri_kodu + ')' : '')],
            ['Sipariş no', noMetin(s.no)],
            ['Ürünler', urunOzeti(kalemler)],
            ['Genel toplam', tl(s.genel_toplam_kurus) + ' (KDV ve kargo dahil)'],
            ['Ödeme', 'Havale/EFT, ödeme bekleniyor'],
            ['Siparişi veren', s.olusturan_ad || '-'],
        ], { dugme: 'Root paneli > Mağaza' });
    } catch (e) { console.error('[magaza] siparis bildirimi:', e.message); }
}

async function odemeBildirildi(s, referans) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        const yeni = await olayYaz(TUR.ODEME, s.id, s.tenant_id, ad,
            `Mağaza ödemesi bildirildi ${noMetin(s.no)} · ${tl(s.genel_toplam_kurus)} · hesabı kontrol edip onaylayın`);
        if (!yeni) return;
        await rootaBildir('Mağaza ödemesi bildirildi: ' + ad, [
            ['İşletme', ad + (s.isyeri_kodu ? ' (kod ' + s.isyeri_kodu + ')' : '')],
            ['Sipariş no', noMetin(s.no)],
            ['Tutar', tl(s.genel_toplam_kurus)],
            ['Referans', referans || '-'],
            ['Yapılacak', 'Banka hesabını kontrol edip Root paneli > Mağaza > Siparişler bölümünden "Ödeme alındı" işaretleyin.'],
        ], { dugme: 'Root paneli > Mağaza' });
    } catch (e) { console.error('[magaza] odeme bildirimi:', e.message); }
}

module.exports = { TUR, yeniSiparis, odemeBildirildi, noMetin, tl };
