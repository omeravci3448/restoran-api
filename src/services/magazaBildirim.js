const { query } = require('../config/db');
const { rootaBildir } = require('./rootBildirim');

// --- Magaza bildirimleri (Patron'a) ---
// Yeni siparis, "odemeyi yaptim", isletmenin iptali ve onay bekleyen odeme hatirlatmasi: rootaBildir (e-posta) +
// root_olaylar satiri. root_olaylar'i yonetim APK'si /api/root/cihaz/bildirim-durumu yanitindaki "olay" alanindan
// okur (yeniKayitIzleyici.telefonOzeti tum turleri doner). UNIQUE(tur, ref): ayni olay bir kez yazilir.
// Bildirim yan istir: hata asil akisi (siparis, odeme bildirimi, iptal) bozmaz.

const TUR = { SIPARIS: 'magaza_siparis', ODEME: 'magaza_odeme', IPTAL: 'magaza_iptal', HATIRLATMA: 'magaza_hatirlatma' };

const tl = (k) => (Number(k || 0) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
const noMetin = (no) => 'MG-' + no;
const DUGME = 'Root paneli > Mağaza';

async function olayYaz(tur, ref, tenantId, baslik, detay) {
    const r = await query(
        'INSERT OR IGNORE INTO root_olaylar (tur, ref, tenant_id, baslik, detay) VALUES (?, ?, ?, ?, ?)',
        [tur, ref, tenantId || null, String(baslik || '').slice(0, 120), String(detay || '').slice(0, 300)]);
    return !!r.changes;
}

function urunOzeti(kalemler) {
    return kalemler.map(k => `${k.adet} x ${k.urun_adi || k.ad}`).join('; ').slice(0, 400);
}
const isletmeSatiri = (s) => (s.isletme_adi || 'İşletme') + (s.isyeri_kodu ? ' (kod ' + s.isyeri_kodu + ')' : '');

async function yeniSiparis(s, kalemler) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        // APK 1.4 bildirim basligi: "Yeni restoran kaydı: <baslik>" (paket_alindi disi turler);
        // metin bu yuzden "Mağaza siparişi" ile baslar.
        const yeni = await olayYaz(TUR.SIPARIS, s.id, s.tenant_id, ad,
            `Mağaza siparişi ${noMetin(s.no)} · ${kalemler.length} kalem · ${tl(s.genel_toplam_kurus)} · havale/EFT bekleniyor`);
        if (!yeni) return;
        await rootaBildir('Mağaza siparişi: ' + ad, [
            ['İşletme', isletmeSatiri(s)],
            ['Sipariş no', noMetin(s.no)],
            ['Ürünler', urunOzeti(kalemler)],
            ['Genel toplam', tl(s.genel_toplam_kurus) + ' (KDV ve kargo dahil)'],
            ['Ödeme', 'Havale/EFT, ödeme bekleniyor'],
            ['Siparişi veren', s.olusturan_ad || '-'],
        ], { dugme: DUGME });
    } catch (e) { console.error('[magaza] siparis bildirimi:', e.message); }
}

async function odemeBildirildi(s, referans) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        const yeni = await olayYaz(TUR.ODEME, s.id, s.tenant_id, ad,
            `Mağaza ödemesi bildirildi ${noMetin(s.no)} · ${tl(s.genel_toplam_kurus)} · hesabı kontrol edip onaylayın`);
        if (!yeni) return;
        await rootaBildir('Mağaza ödemesi bildirildi: ' + ad, [
            ['İşletme', isletmeSatiri(s)],
            ['Sipariş no', noMetin(s.no)],
            ['Tutar', tl(s.genel_toplam_kurus)],
            ['Referans', referans || '-'],
            ['Yapılacak', 'Banka hesabını kontrol edip Root paneli > Mağaza > Siparişler bölümünden "Ödeme alındı" işaretleyin.'],
        ], { dugme: DUGME });
    } catch (e) { console.error('[magaza] odeme bildirimi:', e.message); }
}

// Isletme, odeme bildirmeden once siparisi iptal etti (stok geri dondu).
async function isletmeIptal(s, sebep) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        const yeni = await olayYaz(TUR.IPTAL, s.id, s.tenant_id, ad,
            `Mağaza siparişi ${noMetin(s.no)} işletme tarafından iptal edildi · ${tl(s.genel_toplam_kurus)}`);
        if (!yeni) return;
        await rootaBildir('Mağaza siparişi iptal edildi: ' + ad, [
            ['İşletme', isletmeSatiri(s)],
            ['Sipariş no', noMetin(s.no)],
            ['Tutar', tl(s.genel_toplam_kurus)],
            ['İptal eden', 'İşletme (ödeme bildirilmeden önce)'],
            ['Sebep', sebep || '-'],
        ], { dugme: DUGME });
    } catch (e) { console.error('[magaza] iptal bildirimi:', e.message); }
}

// "Odemeyi yaptim" denmis ama onaylanmamis siparis: 2. gunde ve 3. gunde birer hatirlatma (magazaZamanlayici.js).
// ref = <siparis>:<gun>; ayni asama ikinci kez yazilmaz. Yazildiysa true doner.
async function hatirlatma(s, asama) {
    try {
        const ad = s.isletme_adi || 'İşletme';
        const yeni = await olayYaz(TUR.HATIRLATMA, s.id + ':' + asama, s.tenant_id, ad,
            `Mağaza ödemesi ${asama} gündür onay bekliyor ${noMetin(s.no)} · ${tl(s.genel_toplam_kurus)} · hesabı kontrol edin`);
        if (!yeni) return false;
        await rootaBildir(`Mağaza ödemesi ${asama} gündür onay bekliyor: ${ad}`, [
            ['İşletme', isletmeSatiri(s)],
            ['Sipariş no', noMetin(s.no)],
            ['Tutar', tl(s.genel_toplam_kurus)],
            ['Ödeme bildirimi', String(s.odeme_bildirildi_at || '-').slice(0, 16).replace('T', ' ') + ' (UTC)'],
            ['Yapılacak', 'Ödeme hesaba geçtiyse "Ödeme alındı", geçmediyse sebebini yazarak "İptal et / Reddet". Sipariş onaylanana kadar ayrılan stok kilitli kalır.'],
        ], { dugme: DUGME });
        return true;
    } catch (e) { console.error('[magaza] hatirlatma:', e.message); return false; }
}

module.exports = { TUR, yeniSiparis, odemeBildirildi, isletmeIptal, hatirlatma, noMetin, tl };
